#!/usr/bin/env node
/**
 * npm-pivot.js
 * ==========================================================================
 * Reads the npm registry for every indexed malicious package and npm
 * publisher account, for the packages, accounts, addresses, GitHub
 * repositories and loader packages around them. See docs/npm-pivot.md.
 *
 *   node scripts/npm-pivot.js collect [--force] [--limit N]
 *   node scripts/npm-pivot.js rank [--max-downloads N]
 *
 * The registry is public and needs no token, and nothing here touches the
 * GitHub API, so this runs beside the GitHub pivots without sharing a quota.
 * Results go to _drafts/private/npm-pivot.json, rewritten as it goes.
 */
"use strict";

const fs = require("fs");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { privatePath } = require("./lib/private-data.js");
const np = require("./lib/npm-pivot.js");

const OUT = privatePath("npm-pivot.json");
const GAP_MS = Number(process.env.NPM_GAP_MS) || 250;
// PolinRider's npm values include legitimate packages that were compromised,
// whose maintainers are the victims; those are not read.
const SKIP_CAMPAIGNS = new Set(["PolinRider"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "chollimahunter-npm-pivot" } });
      if (res.status === 404) return { status: 404, body: null };
      if (res.status === 429 || res.status >= 500) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      return { status: res.status, body: res.ok ? await res.json() : null };
    } catch {
      await sleep(3000);
    }
  }
  return { status: 0, body: null };
}

const enc = (name) => name.replace("/", "%2f");

/** Indexed npm packages (bare names) and npm publisher handles, and everything indexed for comparison. */
function fromIndex() {
  const packages = new Set();
  const accounts = new Set();
  const indexed = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    const v = String(r.value);
    const campaigns = [].concat(r.campaign || []);
    const skip = r.attribution_doubt || (campaigns.length && campaigns.every((c) => SKIP_CAMPAIGNS.has(c)));
    if (r.ioc_type === "npm_package") {
      const name = v.toLowerCase();
      indexed.add(name.replace(/(.)@[^@/]+$/, "$1"));
      // A value pinned to a version names a compromised release of someone else's package.
      if (!skip && !/(.)@[^@/]+$/.test(v)) packages.add(name);
    } else if (r.ioc_type === "npm_account") {
      const m = v.match(/npmjs\.com\/~([^/?#]+)/i);
      if (m) {
        indexed.add(`npm:${m[1].toLowerCase()}`);
        if (!skip) accounts.add(m[1].toLowerCase());
      }
    } else if (r.ioc_type === "email_address") {
      const [local, domain] = v.toLowerCase().split("@");
      indexed.add(domain === "gmail.com" || domain === "googlemail.com" ? `${local.split("+")[0].replace(/\./g, "")}@gmail.com` : v.toLowerCase());
    } else if (r.ioc_type === "github_profile") {
      const m = v.match(/github\.com\/([A-Za-z0-9-]+)\/?$/);
      if (m) indexed.add(m[1].toLowerCase());
    }
  }
  return { packages, accounts, indexed };
}

function save(data) {
  writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  data.packages = data.packages || {};
  data.maintainers = data.maintainers || {};
  data.downloads = data.downloads || {};
  const { packages, accounts } = fromIndex();
  const today = new Date().toISOString().slice(0, 10);

  const pkgTodo = [...packages].filter((p) => force || !data.packages[p]).slice(0, limit);
  console.log(`${packages.size} indexed package(s), ${pkgTodo.length} to read`);
  let n = 0;
  for (const name of pkgTodo) {
    const res = await getJson(`https://registry.npmjs.org/${enc(name)}`);
    data.packages[name] = res.body ? { ...np.readPackument(res.body), checked_at: today } : { name, error: res.status, checked_at: today };
    if (++n % 50 === 0) {
      save(data);
      console.log(`  packages ${n}/${pkgTodo.length}`);
    }
  }
  save(data);

  // Every publisher of an indexed package, and every indexed npm account.
  const maintainers = new Set(accounts);
  for (const p of Object.values(data.packages)) for (const person of p.people || []) if (person.name) maintainers.add(person.name);
  const mTodo = [...maintainers].filter((m) => force || !data.maintainers[m]);
  console.log(`${maintainers.size} publisher account(s), ${mTodo.length} to list`);
  n = 0;
  for (const m of mTodo) {
    const res = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${m}`)}&size=250`);
    data.maintainers[m] = { packages: np.namesFromSearch(res.body), total: res.body ? res.body.total : null, checked_at: today };
    if (++n % 50 === 0) {
      save(data);
      console.log(`  accounts ${n}/${mTodo.length}`);
    }
  }
  save(data);

  // Weekly downloads of every dependency of a live indexed package: a loader
  // layer has almost none, a real library has many.
  const deps = new Set();
  for (const p of Object.values(data.packages)) for (const d of p.dependencies || []) deps.add(d);
  const dTodo = [...deps].filter((d) => force || !(d in data.downloads));
  console.log(`${deps.size} dependenc(ies), ${dTodo.length} to look up`);
  for (const d of dTodo) {
    const res = await getJson(`https://api.npmjs.org/downloads/point/last-week/${d}`);
    data.downloads[d] = res.body ? res.body.downloads : res.status === 404 ? 0 : null;
  }
  save(data);
}

function rank(args) {
  const mi = args.indexOf("--max-downloads");
  const maxDownloads = mi >= 0 ? Number(args[mi + 1]) : 1000;
  if (!fs.existsSync(OUT)) {
    console.error(`no ${OUT}; run collect first`);
    process.exit(1);
  }
  const stored = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const { packages: seeds, accounts, indexed } = fromIndex();
  // Only what is still a seed: a value withdrawn since collect leaves the ranking with its publishers.
  const packages = Object.fromEntries(Object.entries(stored.packages || {}).filter(([name]) => seeds.has(name)));
  const reachable = new Set(accounts);
  for (const p of Object.values(packages)) for (const person of p.people || []) if (person.name) reachable.add(person.name);
  const maintainers = Object.fromEntries(Object.entries(stored.maintainers || {}).filter(([m]) => reachable.has(m)));
  const data = { ...stored, packages, maintainers };
  const l = np.leads(data, indexed, { maxDownloads });
  const live = Object.values(data.packages).filter((p) => p && !p.error && !p.holding).length;
  console.log(`${Object.keys(data.packages).length} package(s) read (${live} live), ${Object.keys(data.maintainers).length} publisher account(s) listed\n`);
  const show = (title, rows, fmt) => {
    console.log(`${title} (${rows.length}):`);
    for (const g of rows) console.log(`  ${fmt(g)}  <- ${g.from.slice(0, 5).join(", ")}${g.from.length > 5 ? ` +${g.from.length - 5}` : ""}`);
    console.log("");
  };
  show("Packages published by those accounts, not indexed", l.packages, (g) => g.name.padEnd(40));
  show("Publisher accounts of indexed packages, not indexed", l.accounts, (g) => `${g.name.padEnd(30)} ${g.emails.join(" ")}`);
  show("Publisher addresses, not indexed", l.emails, (g) => g.email.padEnd(40));
  show("GitHub accounts and repositories the packages link, owner not indexed", l.github, (g) => (g.repo || g.owner).padEnd(40));
  show(`Dependencies with ${maxDownloads} or fewer weekly downloads, not indexed`, l.dependencies, (g) => `${g.name.padEnd(36)} ${String(g.downloads).padStart(6)}/wk`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (mode === "rank") rank(rest);
else {
  console.error("usage: npm-pivot.js collect [--force] [--limit N] | rank [--max-downloads N]");
  process.exit(2);
}
