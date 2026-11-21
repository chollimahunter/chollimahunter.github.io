#!/usr/bin/env node
/**
 * gh-bio-twins.js
 * ==========================================================================
 * Finds GitHub accounts outside the index that carry the same profile bio as
 * an indexed account. A persona's bio is often a sentence nobody else on
 * GitHub wrote, so a second account with it word for word is a lead; on 21
 * November 2026 exactly two accounts carried one short motto, both with the
 * same numeric suffix and each holding commits from a different indexed
 * persona.
 *
 *   node scripts/gh-bio-twins.js [--limit N] [--force] [--max-hits N]
 *
 * For each live github_profile it reads the profile (one core API call), then
 * searches users whose bio contains the bio as a phrase (one search call,
 * spaced for the search API's 30 a minute). A bio shorter than four words, or
 * matched by more than --max-hits accounts (default 5), is common text and is
 * recorded without its hits. Results go to _drafts/private/gh-bio-twins.json,
 * rewritten after every account so a stopped run resumes. Leads only; see
 * docs/gh-bio-twins.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const idp = require("./lib/identity-pivot.js");
const { privatePath } = require("./lib/private-data.js");

const OUT = privatePath("gh-bio-twins.json");
const STATUS = path.join(__dirname, "data", "github-account-status.json");
const SEARCH_GAP_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0;

async function ghGet(endpoint, search = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (search) {
      const wait = lastSearch + SEARCH_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastSearch = Date.now();
    }
    const r = spawnSync("gh", ["api", "--include", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new Error(`gh unavailable: ${r.error.message}`);
    const res = idp.parseInclude(r.stdout || "");
    if (res.status >= 200 && res.status < 300) {
      try {
        return JSON.parse(res.body);
      } catch {
        return null;
      }
    }
    if (res.status === 403 || res.status === 429) {
      const secs = idp.backoffSeconds(res.headers);
      console.error(`  ${res.status}; waiting ${secs}s`);
      await sleep(secs * 1000);
      continue;
    }
    return null;
  }
  return null;
}

/** The bio as one line, without characters the search phrase cannot carry. */
function phrase(bio) {
  return String(bio || "")
    // Search drops punctuation and a "|" breaks the phrase entirely (a bio's
    // own account came back with no hits), so only letters, digits and
    // apostrophes are kept.
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A long phrase finds nothing, not even the account itself; the first
    // eight words still found it in every case tested.
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

function seedLogins() {
  const removed = new Set(
    ((fs.existsSync(STATUS) && JSON.parse(fs.readFileSync(STATUS, "utf8")).accounts) || [])
      .filter((a) => a.state === "removed")
      .map((a) => a.login.toLowerCase())
  );
  const all = new Map();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile") continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/?$/);
    if (!m) continue;
    const login = m[1].toLowerCase();
    const bad = removed.has(login) || (r.campaign || []).includes("PolinRider") || r.attribution_doubt;
    all.set(login, all.has(login) ? all.get(login) && !bad : !bad);
  }
  return all;
}

async function main() {
  const args = process.argv.slice(2);
  const num = (flag, fallback) => (args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : fallback);
  const limit = num("--limit", Infinity);
  const maxHits = num("--max-hits", 5);
  const force = args.includes("--force");
  const seeds = seedLogins();
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {} };
  let todo = [...seeds].filter(([, ok]) => ok).map(([l]) => l);
  if (!force) todo = todo.filter((l) => !data.accounts[l]);
  todo = todo.slice(0, limit);
  console.log(`${todo.length} account(s) to check`);

  for (const login of todo) {
    const user = await ghGet(`users/${login}`);
    const bio = phrase(user && user.bio);
    const entry = { bio: bio || null, checked_at: new Date().toISOString().slice(0, 10) };
    if (bio && bio.split(" ").length >= 4) {
      const res = await ghGet(`search/users?q=${encodeURIComponent(`"${bio}" in:bio`)}&per_page=${maxHits + 1}`, true);
      const total = res ? res.total_count : null;
      entry.total = total;
      if (res && total <= maxHits) {
        // The account should find itself; when it does not, the phrase did
        // not survive the search and an empty result means nothing.
        entry.self_found = res.items.some((u) => u.login.toLowerCase() === login);
        entry.twins = res.items.map((u) => u.login).filter((l) => l.toLowerCase() !== login);
      }
    }
    data.accounts[login] = entry;
    writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
    const twins = (entry.twins || []).filter((t) => !seeds.has(t.toLowerCase()));
    if (twins.length) console.log(`${login}: "${bio}" -> ${twins.join(", ")}`);
  }

  // Twins not already in the index, with the indexed accounts that share each bio.
  const leads = new Map();
  for (const [login, e] of Object.entries(data.accounts)) {
    for (const t of e.twins || []) {
      if (seeds.has(t.toLowerCase())) continue;
      if (!leads.has(t)) leads.set(t, { login: t, bio: e.bio, shared_with: [] });
      leads.get(t).shared_with.push(login);
    }
  }
  data.leads = [...leads.values()].sort((a, b) => b.shared_with.length - a.shared_with.length || a.login.localeCompare(b.login));
  writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
  console.log(`${data.leads.length} account(s) outside the index share a rare bio with an indexed one`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
