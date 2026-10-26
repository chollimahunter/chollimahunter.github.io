#!/usr/bin/env node
/**
 * pivot-handles-github.js
 * ==========================================================================
 * Searches GitHub's code for the handles this index holds for named personas
 * and reads each file that names one for contact values beside it, to
 * discover accounts and addresses the index does not hold yet.
 *
 *   node scripts/pivot-handles-github.js [count]
 *
 * Handles come from the persona-anchored github_profile, x_account,
 * telegram_account and linkedin_profile records. Each run takes `count`
 * handles (default 120): never-searched ones first, then the one searched
 * longest ago. For every hit outside research, tracker and bulk-dataset
 * repositories it fetches the file and pulls emails, EVM wallets, Telegram,
 * X, LinkedIn and Discord values within 400 characters of the handle.
 *
 * Results go to scripts/data/handle-pivot-github.json: when each handle was
 * searched, and the sealed keys of leads already reviewed. The leads not yet
 * reviewed go to _drafts/private/handle-pivot-leads.json when the private
 * checkout is present, since most belong to people with no part in any of
 * this; without it (a dispatched Actions run) they go to the public file.
 * NOTHING here is filed as an indicator. The hits are dominated by forks,
 * copied templates, client team pages and test data, so a person reads each
 * lead and files the real ones in direct-observations.json by hand, then moves
 * its key to `reviewed` (sealed on the next run). See docs/handle-pivot.md.
 *
 * Auth: GITHUB_TOKEN (the Actions job token) when set, otherwise `gh api`.
 * Code search allows 10 requests a minute, but the Actions token is penalised
 * well before that, so the run takes about five a minute.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const N = require("./lib/ioc-normalize.js");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { hasPrivateData, privatePath, readPrivateJson, seal } = require("./lib/private-data.js");

const LEADS_FILE = "handle-pivot-leads.json";
const SEALED = /^[0-9a-f]{64}$/;

const COUNT = Number(process.argv[2] || 120);
const STATE = path.join(__dirname, "data", "handle-pivot-github.json");
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The job times out at 90 minutes and a cancelled job saves nothing, so the
// run stops taking new handles well before that and writes what it has.
const DEADLINE = Date.now() + Number(process.env.PIVOT_BUDGET_MINUTES || 70) * 60000;
// On the Actions token code search answers a burst with a 429 asking for a
// wait of four to twelve minutes; that is waited out, anything longer is not.
const MAX_WAIT = 15 * 60000;

class RateLimited extends Error {}

// A 403 is only a rate limit when GitHub says so; anything else (a blocked
// repository, a permissions refusal) is reported as itself rather than
// retried. The wait follows retry-after or the bucket's reset time.
async function api(pathAndQuery) {
  if (process.env.GITHUB_TOKEN) {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch("https://api.github.com/" + pathAndQuery, {
        headers: { authorization: "Bearer " + process.env.GITHUB_TOKEN, accept: "application/vnd.github+json", "user-agent": "chollimahunter-handle-pivot" },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return r.json();
      const body = await r.text();
      const limited = r.status === 429 || (r.status === 403 && (r.headers.get("x-ratelimit-remaining") === "0" || r.headers.has("retry-after") || /rate limit/i.test(body)));
      if (!limited) throw new Error(`HTTP ${r.status}: ${body.slice(0, 160)}`);
      // On a secondary limit the reset time belongs to the hourly bucket, not
      // to the refusal (docs/handle-pivot.md), so it counts only when empty.
      const reset = r.headers.get("x-ratelimit-remaining") === "0" ? Number(r.headers.get("x-ratelimit-reset")) * 1000 - Date.now() : 0;
      const wait = Number(r.headers.get("retry-after")) * 1000 || (reset > 0 ? reset + 1000 : 65000);
      last = `HTTP ${r.status}, wait ${Math.round(wait / 1000)}s: ${body.slice(0, 160)}`;
      if (wait > MAX_WAIT || Date.now() + wait > DEADLINE) break;
      await sleep(wait);
    }
    throw new RateLimited("rate limited (" + last + ")");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(execFileSync("gh", ["api", pathAndQuery], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (e) {
      if (/rate limit|secondary|429/i.test(String(e.stderr || e.message))) { await sleep(65000); continue; }
      throw e;
    }
  }
  throw new RateLimited("rate limited");
}

// Collections of other people's research, trackers and bulk ecosystem data:
// a handle in them is a citation, not an operator's own contact block.
const SKIP_OWNER = /^(chollimahunter|tayvano|theravenfile|blockosint|shortdoom|ketman-org|kawaii-jong-uwun|electric-capital|crypto-ecosystems|solana-foundation|tintinweb|seanpm2001|araguaci|peter279k|lazarus-group|zachxbt|mandiant|opensourcemalware)$/i;
const SKIP_REPO = /open-dev-data|crypto-ecosystems|ecosystems|follow|trending|sanctuary|developer-data|awesome|ioc|threat|intel|lazarus|dprk|north.?korea|blocklist|scam|fraud|phish|malicious|osint|research|stargaz|github-users|user-list|dataset|popularity/i;
const SKIP_PATH = /(^|\/)(followers?|following|stargazers)[^/]*\.(txt|md|json|csv)$|migrations\/|\.lock$|package-lock|yarn\.lock|seeds?\.(rb|js|ts|sql)$/i;

const PATTERNS = [
  ["email_address", /[a-z0-9._%+-]{2,64}@[a-z0-9.-]{2,60}\.[a-z]{2,12}/gi, (v) => N.normalizeEmail(v)],
  ["wallet_address", /\b0x[a-fA-F0-9]{40}\b/g, (v) => v.toLowerCase()],
  ["telegram_account", /(?:t\.me|telegram\.me)\/[A-Za-z0-9_]{5,32}/gi, (v) => N.normalizePlatformAccount(N.PLATFORM_ACCOUNTS.find((s) => s.ioc_type === "telegram_account"))("https://" + v)],
  ["x_account", /(?:twitter|x)\.com\/[A-Za-z0-9_]{2,15}(?![A-Za-z0-9_\/])/gi, (v) => "https://x.com/" + v.split("/").pop()],
  ["linkedin_profile", /linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}/gi, (v) => N.normalizeLinkedin("https://www." + v)],
  ["discord_account", /discord(?:app)?\.com\/users\/\d{15,20}/gi, (v) => "https://discord.com/users/" + v.split("/").pop()],
];

function handlesFromIndex(records) {
  const RE = {
    github_profile: /github\.com\/([^\/?#]+)/,
    telegram_account: /t\.me\/([^\/?#]+)/,
    x_account: /x\.com\/([^\/?#]+)/,
    linkedin_profile: /\/in\/([^\/?#]+)/,
  };
  const out = new Map();
  for (const r of records) {
    if (!r.persona_name || !RE[r.ioc_type]) continue;
    const m = String(r.value).match(RE[r.ioc_type]);
    if (!m || m[1].length < 6) continue;
    const k = m[1].toLowerCase();
    if (!out.has(k)) out.set(k, { handle: m[1], persona: r.persona_name });
  }
  return out;
}

async function main() {
  const index = require("../src/_data/iocIndex.js")();
  const have = new Set(index.records.map((r) => String(r.value).toLowerCase()));
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { searched: {}, reviewed: [], leads: [] };
  const held = hasPrivateData() ? readPrivateJson(LEADS_FILE, { leads: [] }) : null;
  if (held) {
    held.leads.push(...(state.leads || []));
    state.leads = held.leads;
  }
  state.reviewed = [...new Set((state.reviewed || []).map((k) => (SEALED.test(k) ? k : seal(k))))].sort();
  const reviewed = new Set(state.reviewed);
  const pending = new Set(state.leads.map((l) => l.key));

  const handles = [...handlesFromIndex(index.records).values()]
    .map((h) => ({ ...h, last: state.searched[h.handle.toLowerCase()] || "" }))
    .sort((a, b) => a.last.localeCompare(b.last) || a.handle.localeCompare(b.handle))
    .slice(0, COUNT);

  let found = 0;
  let done = 0;
  let limitedInARow = 0;
  for (const h of handles) {
    if (Date.now() > DEADLINE) { console.log(`  time budget spent; stopping after ${done} handles`); break; }
    let items = [];
    try {
      const j = await api(`search/code?q=${encodeURIComponent(`"${h.handle}"`)}&per_page=100`);
      items = j.items || [];
      limitedInARow = 0;
    } catch (e) {
      console.log(`  ${h.handle}: search failed (${e.message})`);
      // Three throttled handles in a row means GitHub is refusing this token
      // for now; the rest keep their place at the front of the rotation.
      if (e instanceof RateLimited && ++limitedInARow >= 3) { console.log("  code search throttled; stopping early"); break; }
      await sleep(6500);
      continue;
    }
    const hits = items.filter((it) => !SKIP_OWNER.test(it.repository.owner.login) && !SKIP_REPO.test(it.repository.full_name) && !SKIP_PATH.test(it.path)).slice(0, 8);
    for (const it of hits) {
      let text;
      try {
        const blob = await api(`repos/${it.repository.full_name}/git/blobs/${it.sha}`);
        text = Buffer.from(String(blob.content || "").replace(/\s/g, ""), "base64").toString("utf8").slice(0, 2e6);
      } catch { continue; }
      const lower = text.toLowerCase();
      let at = lower.indexOf(h.handle.toLowerCase());
      for (let windows = 0; at !== -1 && windows < 5; windows++) {
        const win = text.slice(Math.max(0, at - 400), at + 400);
        for (const [type, re, norm] of PATTERNS) {
          for (const m of win.matchAll(re)) {
            let v;
            try { v = norm(m[0]); } catch { v = null; }
            if (!v || have.has(String(v).toLowerCase())) continue;
            if (type === "email_address" && (N.isExcludedEmail(v) || /noreply|example\.|@users\.noreply/.test(v))) continue;
            const key = [h.handle.toLowerCase(), type, String(v).toLowerCase(), it.repository.full_name.toLowerCase()].join("|");
            if (reviewed.has(seal(key)) || pending.has(key)) continue;
            pending.add(key);
            state.leads.push({
              key, handle: h.handle, persona: h.persona, type, value: v,
              repo: it.repository.full_name, file: it.html_url, found: today,
              context: win.replace(/\s+/g, " ").slice(200, 600),
            });
            found += 1;
          }
        }
        at = lower.indexOf(h.handle.toLowerCase(), at + 1);
      }
    }
    state.searched[h.handle.toLowerCase()] = today;
    done += 1;
    await sleep(12000);
  }
  state._comment =
    "Handle pivot over GitHub code search (scripts/pivot-handles-github.js, weekly .github/workflows/handle-pivot.yml). " +
    "searched: when each persona handle was last searched. reviewed: sealed keys of leads already read, so they never " +
    "come back. leads: values found beside a handle that the index does not hold, NOT YET REVIEWED; none of them is an " +
    "indicator. After reviewing a lead, file it by hand if it is the persona's own (docs/handle-pivot.md) and move its " +
    "key to reviewed, filed or not.";
  state.updated = today;
  const awaiting = state.leads.length;
  if (held) {
    writeFileAtomic(privatePath(LEADS_FILE), JSON.stringify({ ...held, leads: state.leads }, null, 1) + "\n");
    state.leads = [];
  }
  writeFileAtomic(STATE, JSON.stringify(state, null, 1) + "\n");
  console.log(`searched ${done} of ${handles.length} handles, ${found} new leads, ${awaiting} awaiting review`);
  // The searched dates change on every run, and they are what moves the
  // rotation on, so a run that searched anything has something to commit.
  console.log(done ? "CHANGED=true" : "CHANGED=false");
}

main().catch((e) => { console.error(e); process.exit(1); });
