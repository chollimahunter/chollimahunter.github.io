#!/usr/bin/env node
/**
 * gh-commit-network.js
 * ==========================================================================
 * Reads every commit GitHub attributes to each indexed account, in anyone's
 * repository, for the accounts around it. See docs/gh-commit-network.md.
 *
 *   node scripts/gh-commit-network.js collect [--limit N] [--pages N] [--force] [login ...]
 *   node scripts/gh-commit-network.js rank [--min N] [--all]
 *
 * `collect` costs one commit search per account: `author:<login>` for a live
 * account, and for a removed one whose numeric id is known (from the
 * email-owner and rename pivots), its `<id>+<login>` noreply address, since a
 * removed account cannot be searched by name but its commits keep the
 * address. Results go to _drafts/private/gh-commit-network.json after every
 * account, so a stopped run resumes.
 *
 * `rank` prints three tables: repository owners that two or more indexed
 * accounts commit to, author names they commit under that are shared or
 * shaped like another login, and commit addresses the index lacks.
 */
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { privatePath, readPrivateJson } = require("./lib/private-data.js");
const idp = require("./lib/identity-pivot.js");
const cn = require("./lib/commit-network.js");

const OUT = privatePath("gh-commit-network.json");
const SEARCH_GAP_MS = Number(process.env.GH_SEARCH_GAP_MS) || 2100;
const SKIP_CAMPAIGNS = new Set(["PolinRider"]);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0;

async function search(q, page = 1) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastSearch + SEARCH_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSearch = Date.now();
    const endpoint = `search/commits?q=${encodeURIComponent(q)}&sort=author-date&order=desc&per_page=100&page=${page}`;
    const r = spawnSync("gh", ["api", "--include", endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`gh unavailable: ${r.error.message}`);
    const res = idp.parseInclude(r.stdout || "");
    if (res.status >= 200 && res.status < 300) {
      try {
        return { status: res.status, body: JSON.parse(res.body) };
      } catch {
        return { status: res.status, body: null };
      }
    }
    if (res.status === 403 || res.status === 429) {
      const secs = idp.backoffSeconds(res.headers);
      console.error(`  ${res.status} on commit search; waiting ${secs}s`);
      await sleep(secs * 1000);
      continue;
    }
    return { status: res.status, body: null };
  }
  return { status: 0, body: null };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** login (lower) -> numeric id, from the status file and the private pivots. */
function knownIds() {
  const ids = new Map();
  const put = (login, id) => login && id && !ids.has(login.toLowerCase()) && ids.set(login.toLowerCase(), Number(id));
  for (const a of readJson(require.resolve("./data/github-account-status.json"), { accounts: [] }).accounts) put(a.login, a.account_id);
  const owners = (safe(() => readPrivateJson("gh-email-owners.json", {})) || {}).emails || {};
  for (const e of Object.values(owners)) {
    for (const [login, o] of Object.entries(e.owners || {})) put(login, o.id);
    if (e.noreply) put(e.noreply.handle, e.noreply.id);
  }
  const renames = (safe(() => readPrivateJson("gh-renames.json", {})) || {}).handles || {};
  for (const h of Object.values(renames)) for (const [login, a] of Object.entries(h.attributed || {})) put(login, a.id);
  return ids;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Every indexed GitHub account outside PolinRider and without a doubt flag, with its state. */
function seeds() {
  const out = new Map();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile" || r.attribution_doubt) continue;
    const campaigns = [].concat(r.campaign || []);
    if (campaigns.length && campaigns.every((c) => SKIP_CAMPAIGNS.has(c))) continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (!m || !LOGIN.test(m[1])) continue;
    const state = (r.account_status && r.account_status.state) || "unknown";
    out.set(m[1].toLowerCase(), { login: m[1], state });
  }
  return out;
}

function indexedSet() {
  const set = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m) set.add(m[1].toLowerCase());
    if (r.ioc_type === "username") set.add(String(r.value).toLowerCase());
    if (r.ioc_type === "email_address") set.add(cn.fold(r.value));
  }
  return set;
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const pi = args.indexOf("--pages");
  const pages = pi >= 0 ? Number(args[pi + 1]) : 1;
  const named = args.filter((a, i) => !a.startsWith("--") && !["--limit", "--pages"].includes(args[i - 1]));
  const data = readJson(OUT, { accounts: {} });
  const all = seeds();
  const ids = knownIds();
  let todo = named.length ? named.map((l) => all.get(l.toLowerCase()) || { login: l, state: "unknown" }) : [...all.values()];
  if (!force) todo = todo.filter((s) => !data.accounts[s.login.toLowerCase()]);
  // A removed account is searchable only through its id; without one, skip it.
  todo = todo.filter((s) => s.state !== "removed" || ids.has(s.login.toLowerCase()));
  todo = todo.slice(0, limit);
  console.log(`${all.size} indexed account(s), ${todo.length} to read`);
  let n = 0;
  for (const s of todo) {
    const id = ids.get(s.login.toLowerCase());
    const removed = s.state === "removed";
    const q = removed ? `author-email:${id}+${s.login}@users.noreply.github.com` : `author:${s.login}`;
    let query = q;
    let res = await search(query);
    // A live account renamed since it was filed answers 422 to author:; fall back to its id.
    if (!removed && res.status === 422 && id) res = await search((query = `author-email:${id}+${s.login}@users.noreply.github.com`));
    const entry = { login: s.login, id: id || null, state: s.state, query, checked_at: new Date().toISOString().slice(0, 10) };
    if (!res.body) entry.error = res.status;
    else {
      entry.total = res.body.total_count;
      const items = [...(res.body.items || [])];
      // Search serves at most 1,000 results; further pages only when asked for.
      for (let p = 2; p <= Math.min(pages, 10) && items.length < entry.total; p++) {
        const more = await search(query, p);
        if (!more.body || !(more.body.items || []).length) break;
        items.push(...more.body.items);
      }
      entry.commits = items.map((it) => cn.commitFrom(it, removed ? "noreply" : "author"));
    }
    data.accounts[s.login.toLowerCase()] = entry;
    writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
    n++;
    const foreign = new Set((entry.commits || []).map((c) => c.repo && c.repo.split("/")[0]).filter((o) => o && o.toLowerCase() !== s.login.toLowerCase()));
    if (foreign.size) console.log(`${s.login}: ${entry.total} commit(s), in ${foreign.size} other owner(s)' repositories`);
    if (n % 50 === 0) console.log(`  ${n}/${todo.length}`);
  }
}

function rank(args) {
  const mi = args.indexOf("--min");
  const min = mi >= 0 ? Number(args[mi + 1]) : 2;
  const showAll = args.includes("--all");
  const data = readJson(OUT, null);
  if (!data) {
    console.error(`no ${OUT}; run collect first`);
    process.exit(1);
  }
  const indexed = indexedSet();
  const l = cn.leads(cn.network(data.accounts, indexed), { min });
  const mark = (g) => (g.indexed ? "indexed" : "NEW    ");
  const span = (g) => `${g.first || "?"}..${g.last || "?"}`;
  const cap = (rows) => (showAll ? rows : rows.slice(0, 200));
  console.log(`${Object.keys(data.accounts).length} account(s) read\n`);
  console.log(`Repository owners that ${min}+ indexed accounts commit to (${l.owners.length}):`);
  for (const g of cap(l.owners)) console.log(`  ${mark(g)} ${g.owner.padEnd(28)} accounts=${g.seeds.length} commits=${g.commits} ${span(g)} by: ${g.seeds.slice(0, 6).join(",")} | ${g.repos.slice(0, 3).join(" ")}`);
  console.log(`\nAuthor names shared by ${min}+ accounts, or shaped like another login (${l.names.length}):`);
  for (const g of cap(l.names)) console.log(`  ${mark(g)} ${g.name.padEnd(28)} accounts=${g.seeds.length} commits=${g.commits} ${span(g)} by: ${g.seeds.slice(0, 6).join(",")} | ${g.repos.slice(0, 3).join(" ")}`);
  console.log(`\nCommit addresses the index lacks (${l.emails.length}):`);
  for (const g of cap(l.emails)) console.log(`  NEW     ${g.email.padEnd(36)} accounts=${g.seeds.length} commits=${g.commits} ${span(g)} by: ${g.seeds.slice(0, 6).join(",")} | ${g.repos.slice(0, 3).join(" ")}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (mode === "rank") rank(rest);
else {
  console.error("usage: gh-commit-network.js collect [--limit N] [--pages N] [--force] [login ...] | rank [--min N] [--all]");
  process.exit(2);
}
