#!/usr/bin/env node
/**
 * enrich-github-emails.js
 * ==============================================================
 * Pulls the operator's own contact points off a GitHub account: the website
 * it links, and the author email on the commits in the account's OWN
 * repositories. A DPRK IT-worker account commits under a real Gmail far more
 * often than the operator realizes, and that address is one of the strongest
 * links this corpus can hold.
 *
 *   node scripts/enrich-github-emails.js               # live dossier accounts
 *   node scripts/enrich-github-emails.js --live-all    # every live account
 *   node scripts/enrich-github-emails.js --logins a,b  # named accounts
 *   node scripts/enrich-github-emails.js --limit 40
 *
 * WEB ENDPOINTS, NOT THE API
 * --------------------------
 * api.github.com is 60 requests/hour unauthenticated -- two accounts and it is
 * spent. This reads the same facts from github.com web endpoints, which are not
 * on that cap: the profile page for the linked website, ?tab=repositories for
 * the account's repos, commits.atom for a commit SHA, and commit/<sha>.patch
 * for the author email in its From header.
 *
 * WHICH EMAIL IS THE OPERATOR'S
 * -----------------------------
 * A forked repo carries its real upstream author; a bot carries a noreply.
 * The operator is the address that recurs across the account's OWN repos, so
 * this counts across repos and flags the dominant non-bot address. It writes a
 * review file, _drafts/private/github-emails.json, rather than editing the
 * index: the call to add one is a person's, and an unreviewed address may be a
 * real upstream author's.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");

/** Prints the header comment's opening paragraph and exits 0, for --help/-h. */
function printHelp() {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  if (!m) return;
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  let bannerAt = -1;
  for (let j = 0; j < Math.min(lines.length, 6); j++) {
    if (/^=+$/.test(lines[j].trim())) { bannerAt = j; break; }
  }
  let i = bannerAt === -1 ? 0 : bannerAt + 1;
  while (lines[i] !== undefined && !lines[i].trim()) i++;
  const para = [];
  while (lines[i] !== undefined && lines[i].trim()) { para.push(lines[i]); i++; }
  console.log(para.join(" ").replace(/\s+/g, " ").trim());
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const IOCS = path.join(ROOT, "src", "_data", "iocs");
const STATUS = path.join(__dirname, "data", "github-account-status.json");
const OUT = require("./lib/private-data.js").privatePath("github-emails.json");
const H = { "user-agent": "chollimahunter (+https://chollimahunter.github.io)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT = /noreply|dependabot|users\.noreply\.github\.com|actions@github|\[bot\]|@github\.com$/i;

/** Escapes regex metacharacters, so a login containing e.g. "." or "+" can't
 * change what a `new RegExp` built from it matches. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The gap between requests, and the run of 429/403 responses seen in a row.
// Module-level rather than per-call: a 429 on one login's request should slow
// down every request that follows, not just retries of that one call, and the
// whole batch (see the login loop at the bottom of this file) needs to know
// when it has been throttled too many times in a row to keep going.
const MIN_DELAY_MS = 120;
const MAX_DELAY_MS = 60000;
let delayMs = MIN_DELAY_MS;
let consecutiveThrottled = 0;

class BatchThrottledError extends Error {}

async function web(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status === 403) {
        delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
        consecutiveThrottled += 1;
        if (consecutiveThrottled >= 3) {
          throw new BatchThrottledError(
            `${consecutiveThrottled} consecutive 429/403 responses -- stopping batch`
          );
        }
        await sleep(delayMs);
        continue;
      }
      consecutiveThrottled = 0;
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (err) {
      if (err instanceof BatchThrottledError) throw err;
    }
    await sleep(delayMs);
  }
  return null;
}

async function repoNames(login) {
  const html = await web(`https://github.com/${login}?tab=repositories&type=source`);
  if (!html) return [];
  // type=source already excludes forks; parse the repo hrefs.
  const re = new RegExp(`href="/${escapeRegExp(login)}/([A-Za-z0-9._-]+)"`, "g");
  const names = new Set();
  let m;
  while ((m = re.exec(html))) names.add(m[1]);
  names.delete(login);
  return [...names];
}

async function commitShas(login, repo) {
  const atom = await web(`https://github.com/${login}/${repo}/commits.atom`);
  if (!atom) return [];
  return [...new Set([...atom.matchAll(/commit\/([0-9a-f]{40})/g)].map((m) => m[1]))];
}

async function patchEmail(login, repo, sha) {
  const text = await web(`https://github.com/${login}/${repo}/commit/${sha}.patch`);
  if (!text) return null;
  const m = text.match(/^From: [^<]*<([^>]+)>/m);
  return m ? m[1].toLowerCase() : null;
}

async function profileSite(login) {
  const html = await web(`https://github.com/${login}`);
  if (!html) return { gone: true };
  const site = html.match(/itemprop="url"[^>]*>\s*<a[^>]*href="([^"]+)"/) || html.match(/rel="nofollow me"[^>]*href="([^"]+)"/);
  return { site: site ? site[1] : null };
}

async function enrichOne(login) {
  const prof = await profileSite(login);
  if (prof.gone) return { login, gone: true };
  const repos = await repoNames(login);
  const counts = new Map();
  for (const repo of repos.slice(0, 8)) {
    const shas = await commitShas(login, repo);
    for (const sha of shas.slice(0, 3)) {
      const email = await patchEmail(login, repo, sha);
      if (email && !BOT.test(email)) counts.set(email, (counts.get(email) || 0) + 1);
      await sleep(delayMs);
    }
    if ([...counts.values()].some((n) => n >= 3)) break; // dominant found; stop early
    await sleep(delayMs);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    login,
    site: prof.site || null,
    commit_emails: ranked.map(([email, count]) => ({ email, count })),
    likely_operator_email: ranked.length ? ranked[0][0] : null,
  };
}

function liveLogins() {
  const st = JSON.parse(fs.readFileSync(STATUS, "utf8"));
  return new Set((st.accounts || []).filter((a) => a.state === "live").map((a) => a.login.toLowerCase()));
}
function dossierLogins() {
  const s = new Set();
  for (const f of ["x-dossiers.json", "third-party-registries.json", "direct-observations.json"]) {
    const p = path.join(IOCS, f);
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const e of [...(doc.dossiers || []), ...(doc.unattributed || [])])
      for (const i of e.indicators || [])
        if (i.ioc_type === "github_profile") s.add(i.value.split("/").filter(Boolean).pop().toLowerCase());
  }
  return s;
}

(async () => {
  const args = process.argv.slice(2);
  const live = liveLogins();
  let logins;
  const li = args.indexOf("--logins");
  if (li !== -1) logins = args[li + 1].split(",").map((s) => s.trim().toLowerCase());
  else if (args.includes("--live-all")) logins = [...live];
  else logins = [...dossierLogins()].filter((l) => live.has(l));
  const lim = args.indexOf("--limit");
  if (lim !== -1) logins = logins.slice(0, Number(args[lim + 1]));

  const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { generated: null, accounts: {} };
  console.error(`${logins.length} accounts (web endpoints, no API cap)`);
  let n = 0;
  for (const login of logins) {
    if (done.accounts[login] && li === -1) { n++; continue; }
    let res;
    try {
      res = await enrichOne(login);
    } catch (err) {
      if (err instanceof BatchThrottledError) {
        console.error(`  ${err.message}; stopping after ${n}/${logins.length}`);
        break;
      }
      throw err;
    }
    done.accounts[login] = res;
    n++;
    if (res.likely_operator_email) console.log(`  ${login} -> ${res.likely_operator_email}${res.site ? " | " + res.site : ""}`);
    else if (res.gone) console.log(`  ${login} -> (gone)`);
    if (n % 10 === 0) { done.generated = new Date().toISOString().slice(0, 10); writeFileAtomic(OUT, JSON.stringify(done, null, 2) + "\n"); console.error(`  ...${n}/${logins.length}`); }
  }
  done.generated = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileAtomic(OUT, JSON.stringify(done, null, 2) + "\n");
  console.error(`done: ${Object.keys(done.accounts).length} in ${path.relative(ROOT, OUT)}`);
})();
