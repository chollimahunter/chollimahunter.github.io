#!/usr/bin/env node
/**
 * gh-identity-pivot.js
 * ==========================================================================
 * The part of GitFive's method that needs only the public GitHub API. For each
 * indexed github_profile it collects the author names and addresses the account
 * committed with (its own repositories' commits and its public events feed),
 * then searches commits by each address to find OTHER logins that used it.
 *
 *   node scripts/gh-identity-pivot.js [--limit N] [--force] [login ...]
 *
 * With no logins it takes the index's github_profile accounts that have no
 * entry yet in _drafts/private/gh-identity-pivot.json (oldest check first once all
 * have one). The file is rewritten after every login, so an interrupted run
 * resumes where it stopped. Authentication is `gh api`, which never exposes a
 * token. Results are leads for a human and reach no published page; see
 * docs/gh-identity-pivot.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const idp = require("./lib/identity-pivot.js");

// Commit identities include upstream authors of copied code, so the review file
// lives in the private checkout.
const OUT = require("./lib/private-data.js").privatePath("gh-identity-pivot.json");
const MAX_REPOS = 15;
const COMMITS_PER_REPO = 100;
const SEARCH_GAP_MS = 2500; // search API allows 30 requests a minute
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0;

/** One `gh api` call; retries on 403/429 after the server's back-off. Returns parsed JSON or null. */
async function ghGet(endpoint, { search = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (search) {
      const wait = lastSearch + SEARCH_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastSearch = Date.now();
    }
    const r = spawnSync("gh", ["api", "--include", endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
      console.error(`  ${res.status} on ${endpoint.split("?")[0]}; waiting ${secs}s`);
      await sleep(secs * 1000);
      continue;
    }
    return null; // 404, 409 (empty repository), 422 and the like: nothing to read
  }
  return null;
}

const toList = (map, extra) =>
  [...map.entries()].map(([value, seen]) => ({ value, ...(extra ? extra(value) : {}), seen })).sort((a, b) => a.value.localeCompare(b.value));

async function pivot(login, emailCache) {
  const ids = idp.emptyIdentities();
  const repos = (await ghGet(`users/${login}/repos?type=owner&sort=pushed&per_page=100`)) || [];
  const own = repos.filter((r) => !r.fork).slice(0, MAX_REPOS);
  for (const r of own) {
    const commits = await ghGet(`repos/${r.full_name}/commits?author=${login}&per_page=${COMMITS_PER_REPO}`);
    idp.identitiesFromCommits(commits, login, r.full_name, ids);
  }
  idp.identitiesFromEvents(await ghGet(`users/${login}/events/public?per_page=100`), ids);

  const shared = new Map(); // other login -> { emails: [], repo, sha }
  for (const email of ids.emails.keys()) {
    if (!emailCache.has(email)) {
      const res = await ghGet(`search/commits?q=${encodeURIComponent(`author-email:${email}`)}&per_page=50`, { search: true });
      emailCache.set(email, res ? idp.otherLogins(res.items, login) : new Map());
    }
    for (const [other, where] of emailCache.get(email)) {
      if (other.toLowerCase() === login.toLowerCase()) continue;
      if (!shared.has(other)) shared.set(other, { login: other, via_email: email, ...where });
    }
  }
  return {
    emails: toList(ids.emails),
    noreply_ids: toList(ids.noreplyIds, (v) => idp.noreplyIdentity(v)),
    names: toList(ids.names),
    other_logins: [...shared.values()].sort((a, b) => a.login.localeCompare(b.login)),
    repos_read: own.length,
    checked_at: new Date().toISOString().slice(0, 10),
  };
}

function indexLogins() {
  const logins = [];
  for (const r of require("../src/_data/iocIndex.js")().records) {
    const m = r.ioc_type === "github_profile" && String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m && LOGIN.test(m[1])) logins.push(m[1]);
  }
  return [...new Set(logins)];
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  if (li >= 0 && !(limit > 0)) {
    console.error("--limit needs a positive number");
    process.exit(2);
  }
  const named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
  const bad = named.filter((l) => !LOGIN.test(l));
  if (bad.length) {
    console.error(`not a GitHub login: ${bad.join(", ")}`);
    process.exit(2);
  }

  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {} };
  const have = (l) => data.accounts[l.toLowerCase()];
  let targets = named.length ? named : indexLogins();
  if (!force) targets = targets.filter((l) => !have(l));
  targets = targets.slice(0, limit);
  console.log(`${targets.length} account(s) to check`);

  const emailCache = new Map();
  for (const login of targets) {
    console.log(`${login}`);
    const result = await pivot(login, emailCache);
    data.accounts[login.toLowerCase()] = result;
    writeFileAtomic(OUT, JSON.stringify(data, null, 2) + "\n");
    console.log(`  ${result.emails.length} address(es), ${result.names.length} name(s), ${result.other_logins.length} other login(s)`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
