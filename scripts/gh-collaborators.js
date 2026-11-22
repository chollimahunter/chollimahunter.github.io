#!/usr/bin/env node
/**
 * gh-collaborators.js
 * ==========================================================================
 * Finds the accounts that work inside indexed personas' own repositories.
 *
 * Operator teams share repositories: on 22 November 2026 one listed account's
 * casino repository carried commits from four indexed personas and two
 * addresses nobody had listed, interleaved over the same weeks. Reading who
 * commits in a persona's repository is therefore a pivot of its own, but most
 * of what a persona's repositories carry is copied history: a template's
 * upstream authors, committed years before the persona's copy existed. The
 * test that separates the two is the date. A commit dated before the
 * repository was created in this account is history that came with the copy;
 * a commit dated after it is somebody working in the repository.
 *
 *   node scripts/gh-collaborators.js collect [--limit N] [--force] [--repos N]
 *   node scripts/gh-collaborators.js rank [--min N]
 *
 * `collect` reads, for each live indexed github_profile, its most recently
 * pushed non-fork repositories (default 20) and their latest 100 commits, and
 * keeps every identity other than the owner's that committed after the
 * repository was created: the account GitHub attributes the commit to, the
 * author address and name, and the account id inside a noreply address.
 * Results go to _drafts/private/gh-collaborators.json after every account.
 * Core API only, so it does not compete with the search-based pivots.
 *
 * `rank` groups the identities across owners and keeps those found working in
 * at least --min (default 2) distinct indexed accounts' repositories. A
 * collaborator of two personas is a lead; one of fifty is a client or a
 * popular template, and is listed with its count so a reader can tell.
 */
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const idp = require("./lib/identity-pivot.js");

const OUT = require("./lib/private-data.js").privatePath("gh-collaborators.json");
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const DAY = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghGet(endpoint) {
  for (let attempt = 0; attempt < 5; attempt++) {
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

function liveLogins() {
  const out = [];
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile") continue;
    const state = r.account_status && r.account_status.state;
    if (state === "removed" || state === "recycled") continue;
    const campaigns = [].concat(r.campaign || []);
    if (campaigns.includes("PolinRider") || r.attribution_doubt) continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m && LOGIN.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Identities other than the owner's that committed after the repository was created. */
function workersIn(commits, owner, repo) {
  const created = Date.parse(repo.created_at) - DAY;
  const found = [];
  for (const c of commits || []) {
    const a = (c.commit && c.commit.author) || {};
    const when = Date.parse((c.commit && c.commit.committer && c.commit.committer.date) || a.date || "");
    if (!(when >= created)) continue;
    const login = c.author && c.author.login;
    if (login && login.toLowerCase() === owner.toLowerCase()) continue;
    const email = String(a.email || "").toLowerCase();
    const nr = idp.noreplyIdentity(email);
    if (!login && nr && nr.login.toLowerCase() === owner.toLowerCase()) continue;
    found.push({
      login: login || null,
      id: (c.author && c.author.id) || (nr && nr.id) || null,
      email: idp.isNoreply(email) && !nr ? null : email,
      name: String(a.name || "").trim(),
      date: String(a.date || "").slice(0, 10),
      sha: String(c.sha || "").slice(0, 12),
    });
  }
  return found;
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const ri = args.indexOf("--repos");
  const maxRepos = ri >= 0 ? Number(args[ri + 1]) : 20;
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {} };
  const named = args.filter((a, i) => !a.startsWith("--") && !["--limit", "--repos"].includes(args[i - 1]));
  let todo = named.length ? named : liveLogins();
  if (!force) todo = todo.filter((l) => !data.accounts[l.toLowerCase()]);
  todo = todo.slice(0, limit);
  console.log(`${todo.length} account(s) to read`);
  let n = 0;
  for (const owner of todo) {
    const repos = ((await ghGet(`users/${owner}/repos?type=owner&sort=pushed&per_page=100`)) || []).filter((r) => !r.fork).slice(0, maxRepos);
    const workers = [];
    for (const repo of repos) {
      const commits = await ghGet(`repos/${repo.full_name}/commits?per_page=100`);
      for (const w of workersIn(commits, owner, repo)) workers.push({ repo: repo.name, ...w });
    }
    data.accounts[owner.toLowerCase()] = { owner, repos_read: repos.length, workers, checked_at: new Date().toISOString().slice(0, 10) };
    writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
    n++;
    const distinct = new Set(workers.map((w) => w.login || w.email || w.name));
    if (distinct.size) console.log(`${owner}: ${distinct.size} other identit(ies) in ${repos.length} repo(s)`);
    if (n % 50 === 0) console.log(`  ${n}/${todo.length}`);
  }
}

/** Gmail ignores dots and anything after a plus, and the index stores the folded form. */
function fold(email) {
  const [local, domain] = String(email || "").toLowerCase().split("@");
  if (!domain) return String(email || "").toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  return `${local}@${domain}`;
}

function rank(args) {
  const mi = args.indexOf("--min");
  const min = mi >= 0 ? Number(args[mi + 1]) : 2;
  const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const indexed = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m) indexed.add(m[1].toLowerCase());
    if (r.ioc_type === "email_address") indexed.add(fold(r.value));
  }
  const groups = new Map();
  for (const acc of Object.values(data.accounts)) {
    for (const w of acc.workers) {
      const key = w.login ? `login:${w.login.toLowerCase()}` : w.id ? `id:${w.id}` : w.email ? `email:${w.email}` : null;
      if (!key || /\[bot\]$/i.test(w.login || "")) continue;
      const g = groups.get(key) || { key, login: w.login, id: w.id, owners: new Set(), emails: new Set(), names: new Set(), commits: 0, first: w.date, last: w.date };
      g.owners.add(acc.owner);
      if (w.email) g.emails.add(w.email);
      if (w.name) g.names.add(w.name);
      g.commits++;
      if (w.date < g.first) g.first = w.date;
      if (w.date > g.last) g.last = w.date;
      groups.set(key, g);
    }
  }
  // --hints: also keep a single-owner identity whose login, address or name
  // shares a word stem (4+ letters) or a digit run (3+) with the owner's
  // login or the owner's own commit addresses, read from the identity pivot
  // and email-owner results when they exist.
  const hints = args.includes("--hints");
  const ownerTokens = new Map();
  if (hints) {
    const { readPrivateJson } = require("./lib/private-data.js");
    const idpData = (safeRead(readPrivateJson, "gh-identity-pivot.json") || {}).accounts || {};
    const owned = (safeRead(readPrivateJson, "gh-email-owners.json") || {}).emails || {};
    for (const acc of Object.values(data.accounts)) {
      const texts = [acc.owner, ...((idpData[acc.owner.toLowerCase()] || {}).emails || []).map((e) => e.value)];
      for (const [email, e] of Object.entries(owned)) if (Object.keys(e.owners || {}).some((l) => l.toLowerCase() === acc.owner.toLowerCase())) texts.push(email);
      ownerTokens.set(acc.owner, new Set(texts.flatMap(tokens)));
    }
  }
  const hintFor = (g) => {
    if (!hints || g.owners.size !== 1) return null;
    const own = ownerTokens.get([...g.owners][0]) || new Set();
    const mine = [g.login || "", ...g.emails, ...g.names].flatMap(tokens);
    return mine.find((t) => own.has(t)) || null;
  };
  const rows = [...groups.values()]
    .map((g) => ({ ...g, hint: hintFor(g) }))
    .filter((g) => g.owners.size >= min || g.hint)
    .sort((a, b) => b.owners.size - a.owners.size || b.commits - a.commits);
  console.log(`${Object.keys(data.accounts).length} account(s) read; ${rows.length} identit(ies) working in ${min}+ indexed accounts' repositories${hints ? " or sharing a token with their one owner" : ""}`);
  for (const g of rows) {
    const known = (g.login && indexed.has(g.login.toLowerCase())) || [...g.emails].some((e) => indexed.has(fold(e)));
    console.log(
      `${known ? "indexed" : "NEW    "} ${String(g.login || g.key).padEnd(30)} owners=${g.owners.size} commits=${g.commits} ${g.first}..${g.last} ` +
        `${g.hint ? `shares "${g.hint}" ` : ""}in: ${[...g.owners].slice(0, 6).join(",")} | ${[...g.emails].slice(0, 2).join(",")} | ${[...g.names].slice(0, 3).join(",")}`
    );
  }
}

/** Word stems of 4+ letters and digit runs of 3+, lower-cased; mail domains and filler words dropped. */
const FILLER = new Set(["gmail", "outlook", "hotmail", "yahoo", "proton", "protonmail", "users", "noreply", "github", "icloud", "mail", "work", "team", "info", "admin", "contact", "support", "hello", "user", "code", "coder", "codes", "devs", "developer", "develop", "senior", "full", "stack", "fullstack", "engineer", "software", "master", "super", "star", "best", "smart", "crypto", "block", "chain", "blockchain", "tech", "unknown", "solana"]);
function tokens(text) {
  const t = String(text || "").toLowerCase().replace(/@.*$/, "").replace(/^\d+\+/, "");
  const words = (t.match(/[a-z]{4,}/g) || []).filter((w) => !FILLER.has(w));
  const digits = t.match(/\d{3,}/g) || [];
  return [...words, ...digits];
}

function safeRead(fn, name) {
  try {
    return fn(name);
  } catch {
    return null;
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (mode === "rank") rank(rest);
else {
  console.error("usage: gh-collaborators.js collect [--limit N] [--force] [--repos N] [login ...] | rank [--min N]");
  process.exit(2);
}
