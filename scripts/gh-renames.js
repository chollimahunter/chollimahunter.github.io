#!/usr/bin/env node
/**
 * gh-renames.js
 * ==========================================================================
 * Looks for indexed GitHub accounts recorded as removed that were only
 * renamed.
 *
 * A removed account's commits vanish from GitHub's attribution, but a renamed
 * one's do not: the commits it made under its old handle are still attributed
 * to it under the new one. On 22 November 2026 the listed account newstable,
 * by then answering 404, turned out to be account 97214534 under a fourth
 * name. A commit search by author name for each dead handle finds the commits
 * the account signed with it; GitHub's attribution on those commits names the
 * account that made them today, and a noreply address carrying the old handle
 * with that account's id makes the rename certain.
 *
 *   node scripts/gh-renames.js collect [--limit N] [--force]
 *   node scripts/gh-renames.js rank
 *
 * `collect` takes the index's github_profile accounts whose status is removed,
 * runs one commit search by author name per handle (spaced for the search
 * API's 30 a minute) and records the accounts the matching commits are
 * attributed to and any noreply id under the handle, in
 * _drafts/private/gh-renames.json. `rank` prints each dead handle with the
 * account it resolves to: PROVEN when a noreply address ties the old handle to
 * that account's id, NAME when only the author name matches (which is weaker:
 * anyone can type any name into a commit).
 */
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const idp = require("./lib/identity-pivot.js");

const OUT = require("./lib/private-data.js").privatePath("gh-renames.json");
const SEARCH_GAP_MS = Number(process.env.GH_SEARCH_GAP_MS) || 2100; // 30 searches a minute; commit search often needs more room
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0;

async function ghGet(endpoint, { search = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
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
    return null;
  }
  return null;
}

function removedHandles() {
  const out = [];
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile") continue;
    if (!(r.account_status && r.account_status.state === "removed")) continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m && LOGIN.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { handles: {} };
  let todo = removedHandles();
  if (!force) todo = todo.filter((h) => !data.handles[h.toLowerCase()]);
  todo = todo.slice(0, limit);
  console.log(`${todo.length} removed handle(s) to check`);
  let n = 0;
  for (const handle of todo) {
    const res = await ghGet(`search/commits?q=${encodeURIComponent(`author-name:${handle}`)}&per_page=100`, { search: true });
    const entry = { checked_at: new Date().toISOString().slice(0, 10), total: res ? res.total_count : null, attributed: {}, noreply: {} };
    for (const it of (res && res.items) || []) {
      const name = String((it.commit && it.commit.author && it.commit.author.name) || "");
      if (name.toLowerCase() !== handle.toLowerCase()) continue;
      const email = String(it.commit.author.email || "").toLowerCase();
      const nr = idp.noreplyIdentity(email);
      if (nr && nr.login.toLowerCase() === handle.toLowerCase()) entry.noreply[nr.id] = (entry.noreply[nr.id] || 0) + 1;
      if (it.author && it.author.login) {
        const a = (entry.attributed[it.author.login] = entry.attributed[it.author.login] || { id: it.author.id, commits: 0, emails: [], repo: null });
        a.commits++;
        if (email && !a.emails.includes(email) && a.emails.length < 4) a.emails.push(email);
        if (!a.repo) a.repo = it.repository && it.repository.full_name;
      }
    }
    // A noreply id no attributed commit explained: resolve it directly.
    for (const id of Object.keys(entry.noreply)) {
      if (Object.values(entry.attributed).some((a) => String(a.id) === id)) continue;
      const u = await ghGet(`user/${id}`);
      if (u && u.login) entry.attributed[u.login] = { id: Number(id), commits: 0, emails: [], repo: null, via: "noreply id" };
    }
    data.handles[handle.toLowerCase()] = { handle, ...entry };
    writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
    n++;
    const now = Object.keys(entry.attributed).filter((l) => l.toLowerCase() !== handle.toLowerCase());
    if (now.length) console.log(`${handle} -> ${now.join(", ")}`);
    if (n % 50 === 0) console.log(`  ${n}/${todo.length}`);
  }
}

function rank() {
  const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const indexed = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m) indexed.add(m[1].toLowerCase());
  }
  let shown = 0;
  for (const e of Object.values(data.handles)) {
    for (const [login, a] of Object.entries(e.attributed)) {
      if (login.toLowerCase() === e.handle.toLowerCase()) continue;
      const proven = Object.keys(e.noreply).includes(String(a.id));
      shown++;
      console.log(
        `${proven ? "PROVEN" : "NAME  "} ${e.handle.padEnd(26)} -> ${login.padEnd(26)} id=${a.id} ${indexed.has(login.toLowerCase()) ? "(indexed)" : "(new)"} ` +
          `${a.commits} commits ${a.emails.slice(0, 2).join(",")} ${a.repo || ""}`
      );
    }
  }
  console.log(`${Object.keys(data.handles).length} removed handle(s) checked, ${shown} resolve to another account`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (mode === "rank") rank();
else {
  console.error("usage: gh-renames.js collect [--limit N] [--force] | rank");
  process.exit(2);
}
