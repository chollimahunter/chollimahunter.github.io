#!/usr/bin/env node
/**
 * gh-email-owners.js
 * ==========================================================================
 * Finds the GitHub account that holds each indexed email address.
 *
 * GitHub attributes a commit to an account (the `author` object in the API)
 * only when the commit's author address is one of that account's verified
 * addresses, and it keeps doing so after the account is renamed. One commit
 * search per indexed address therefore names the account that controls it
 * today, whoever made the commit: a persona's own account under a name this
 * index has never seen, or an indexed account that has since been renamed.
 * A noreply address (`<id>+<login>@users.noreply.github.com`) needs no search
 * at all: its numeric id resolves to the account's current login directly.
 *
 *   node scripts/gh-email-owners.js collect [--limit N] [--force]
 *   node scripts/gh-email-owners.js rank [--all]
 *
 * `collect` reads every indexed email_address record and the DTEX bulk list,
 * except campaigns whose addresses are spoofed senders or affected owners
 * rather than operators (Kimsuky, APT37, Konni, APT38, Andariel, PolinRider),
 * and writes _drafts/private/gh-email-owners.json after every address, so a
 * stopped run resumes. `rank` lists the owning accounts the index does not
 * hold as a github_profile, grouped by account; --all includes held ones.
 *
 * Every row is a lead for a person to read, never a finding. An address in a
 * published list can be a victim's or a borrowed identity's, and the account
 * holding it is then that person's. Results reach no published page.
 */
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const idp = require("./lib/identity-pivot.js");

const OUT = require("./lib/private-data.js").privatePath("gh-email-owners.json");
const SEARCH_GAP_MS = Number(process.env.GH_SEARCH_GAP_MS) || 2100; // 30 searches a minute; commit search often needs more room
const SKIP_CAMPAIGNS = new Set(["Kimsuky", "APT37", "Konni", "APT38", "Andariel", "PolinRider"]);

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
        return { status: res.status, body: JSON.parse(res.body) };
      } catch {
        return { status: res.status, body: null };
      }
    }
    if (res.status === 403 || res.status === 429) {
      const secs = idp.backoffSeconds(res.headers);
      console.error(`  ${res.status} on ${endpoint.split("?")[0]}; waiting ${secs}s`);
      await sleep(secs * 1000);
      continue;
    }
    return { status: res.status, body: null };
  }
  return { status: 0, body: null };
}

/** The indexed addresses worth asking about, with the records behind each. */
function targets() {
  const out = new Map();
  const add = (email, ref) => {
    const e = String(email || "").trim().toLowerCase();
    if (!e.includes("@")) return;
    if (!out.has(e)) out.set(e, []);
    out.get(e).push(ref);
  };
  const recs = require("../src/_data/iocIndex.js")().records;
  for (const r of recs) {
    if (r.ioc_type !== "email_address") continue;
    const campaigns = [].concat(r.campaign || []);
    if (campaigns.length && campaigns.every((c) => SKIP_CAMPAIGNS.has(c))) continue;
    add(r.value, { id: r.id, campaign: campaigns });
  }
  const datasets = require("../src/_data/iocs/itworker-datasets.json");
  const list = Array.isArray(datasets) ? datasets : datasets.datasets || Object.values(datasets).find(Array.isArray);
  for (const d of list || []) {
    if (d.ioc_type !== "email_address") continue;
    for (const e of d.entries || []) add(typeof e === "string" ? e : e.value, { dataset: d.dataset_id, campaign: [].concat(d.campaign || []) });
  }
  return out;
}

/** Accounts GitHub attributes commits by this address to, from one search page. */
function ownersFrom(items) {
  const owners = {};
  const names = {};
  for (const it of items || []) {
    const name = it.commit && it.commit.author && it.commit.author.name;
    if (name) names[name] = (names[name] || 0) + 1;
    if (!it.author || !it.author.login) continue;
    const o = (owners[it.author.login] = owners[it.author.login] || { id: it.author.id, commits: 0, repos: [], first: null, last: null });
    o.commits++;
    const repo = it.repository && it.repository.full_name;
    if (repo && !o.repos.includes(repo) && o.repos.length < 5) o.repos.push(repo);
    const date = String((it.commit.author && it.commit.author.date) || "").slice(0, 10);
    if (date) {
      if (!o.first || date < o.first) o.first = date;
      if (!o.last || date > o.last) o.last = date;
    }
  }
  return { owners, names };
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { emails: {} };
  const all = targets();
  let todo = [...all.keys()].filter((e) => force || !data.emails[e]);
  // Noreply addresses first: they cost no search and settle renames outright.
  todo.sort((a, b) => Number(idp.isNoreply(b)) - Number(idp.isNoreply(a)));
  todo = todo.slice(0, limit);
  console.log(`${all.size} indexed address(es), ${todo.length} to check`);
  let n = 0;
  for (const email of todo) {
    const entry = { checked_at: new Date().toISOString().slice(0, 10), refs: all.get(email).slice(0, 5) };
    const nr = idp.noreplyIdentity(email);
    if (nr) {
      const res = await ghGet(`user/${nr.id}`);
      entry.noreply = { id: nr.id, handle: nr.login, current: res.body ? res.body.login : null, status: res.status };
      if (res.body) entry.owners = { [res.body.login]: { id: nr.id, commits: 0, repos: [], via: "noreply id" } };
    } else if (idp.isNoreply(email)) {
      entry.skipped = "noreply address without an id";
    } else {
      const res = await ghGet(`search/commits?q=${encodeURIComponent(`author-email:${email}`)}&per_page=100`, { search: true });
      if (!res.body) {
        entry.error = res.status;
      } else {
        entry.total = res.body.total_count;
        Object.assign(entry, ownersFrom(res.body.items));
      }
    }
    data.emails[email] = entry;
    writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
    n++;
    const owners = Object.keys(entry.owners || {});
    if (owners.length) console.log(`${email} -> ${owners.join(", ")}`);
    if (n % 100 === 0) console.log(`  ${n}/${todo.length}`);
  }
}

function indexedLogins() {
  const set = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m) set.add(m[1].toLowerCase());
    if (r.ioc_type === "username") set.add(String(r.value).toLowerCase());
  }
  return set;
}

function rank(args) {
  const all = args.includes("--all");
  const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const known = indexedLogins();
  const byLogin = new Map();
  for (const [email, e] of Object.entries(data.emails)) {
    for (const [login, o] of Object.entries(e.owners || {})) {
      if (!all && known.has(login.toLowerCase())) continue;
      // An address also tagged PolinRider belongs to an affected repository's
      // owner as often as to an operator, so its holder is not a lead.
      if ((e.refs || []).some((ref) => (ref.campaign || []).includes("PolinRider"))) continue;
      const row = byLogin.get(login) || { login, id: o.id, emails: [], commits: 0, campaigns: new Set(), renamedFrom: new Set() };
      row.emails.push(email);
      row.commits += o.commits || 0;
      for (const ref of e.refs || []) for (const c of ref.campaign || []) row.campaigns.add(c);
      if (e.noreply && e.noreply.handle.toLowerCase() !== login.toLowerCase()) row.renamedFrom.add(e.noreply.handle);
      byLogin.set(login, row);
    }
  }
  const rows = [...byLogin.values()].sort((a, b) => b.emails.length - a.emails.length || b.commits - a.commits);
  const checked = Object.keys(data.emails).length;
  const owned = Object.values(data.emails).filter((e) => Object.keys(e.owners || {}).length).length;
  console.log(`${checked} address(es) checked, ${owned} held by an account, ${rows.length} account(s) ${all ? "in all" : "outside the index"}`);
  for (const r of rows) {
    const mark = known.has(r.login.toLowerCase()) ? "indexed" : "NEW";
    const was = r.renamedFrom.size ? ` was ${[...r.renamedFrom].join("/")}` : "";
    console.log(`${mark.padEnd(7)} ${r.login.padEnd(26)} id=${r.id} ${r.emails.length} addr ${r.commits} commits [${[...r.campaigns].join(", ")}]${was}  ${r.emails.slice(0, 3).join(" ")}`);
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (mode === "rank") rank(rest);
else {
  console.error("usage: gh-email-owners.js collect [--limit N] [--force] | rank [--all]");
  process.exit(2);
}
