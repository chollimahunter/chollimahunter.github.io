#!/usr/bin/env node
/**
 * ct-pivot.js
 * ==========================================================================
 * Reads certificate-transparency logs for every indexed operator domain, for
 * the domains and hosts that share its certificates. See docs/ct-pivot.md.
 *
 *   node scripts/ct-pivot.js collect [--force] [--limit N] [domain ...]
 *   node scripts/ct-pivot.js rank
 *
 * One request per registrable domain to Cert Spotter's public API (every
 * certificate naming the domain or a subdomain, with all its names and key
 * hash), falling back to crt.sh when Cert Spotter refuses. No key is needed;
 * Cert Spotter allows about 100 unauthenticated requests an hour, in short
 * bursts, and the script waits out a refusal, so a full pass of about 480
 * domains takes about five hours: run it in the background. Results go to
 * _drafts/private/ct-pivot.json after every domain, so a stopped run resumes.
 */
"use strict";

const fs = require("fs");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { privatePath } = require("./lib/private-data.js");
const { registrableDomain, loadSuffixes, hostOf } = require("./enrich-domains.js");
const ct = require("./lib/ct-pivot.js");

const OUT = privatePath("ct-pivot.json");
const SEED_TYPES = new Set(["domain", "personal_site"]);
const UA = { "User-Agent": "chollimahunter-ct-pivot", Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
    const retry = Number(res.headers.get("retry-after")) || 0;
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    if (!res.ok) return { status: res.status, retry, remaining, body: null };
    return { status: res.status, retry, remaining, body: await res.json() };
  } catch {
    return { status: 0, retry: 0, remaining: NaN, body: null };
  }
}

/** Every certificate naming the domain or a subdomain: names, start date and key hash. */
async function certificates(domain) {
  const certs = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const r = await fetchJson(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names${after ? `&after=${after}` : ""}`);
    if (r.status === 429) {
      await sleep(Math.max(r.retry, 30) * 1000);
      page--;
      continue;
    }
    if (!r.body) return crtsh(domain);
    for (const c of r.body) certs.push({ id: c.id, names: c.dns_names || [], not_before: c.not_before, pubkey: c.pubkey_sha256 });
    if (Number.isFinite(r.remaining) && r.remaining <= 1) await sleep(60000);
    else await sleep(6500);
    if (r.body.length < 100) break;
    after = r.body[r.body.length - 1].id;
  }
  return { certs, via: "certspotter" };
}

/** crt.sh gives names but no key hash; used when Cert Spotter will not answer. */
async function crtsh(domain) {
  const certs = new Map();
  for (const q of [domain, `%.${domain}`]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetchJson(`https://crt.sh/?q=${encodeURIComponent(q)}&output=json`);
      if (r.body) {
        for (const c of r.body) {
          const prev = certs.get(c.id) || { id: c.id, names: [], not_before: c.not_before, pubkey: null };
          prev.names.push(...String(c.name_value || "").split("\n"));
          certs.set(c.id, prev);
        }
        break;
      }
      await sleep(10000);
    }
    await sleep(3000);
  }
  return certs.size ? { certs: [...certs.values()], via: "crt.sh" } : { error: "no answer from Cert Spotter or crt.sh" };
}

function readStore() {
  return fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { domains: {} };
}

/** Registrable operator domains in the index, and every indexed host for comparison. */
function fromIndex(rules) {
  const seeds = new Set();
  const indexed = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (!["domain", "personal_site", "hosted_site"].includes(r.ioc_type)) continue;
    const host = hostOf(r.value);
    if (!host) continue;
    indexed.add(host);
    const reg = registrableDomain(host, rules);
    if (reg) indexed.add(reg);
    // Only a value that is itself registrable, as in enrich-domains.js: the
    // ICANN list leaves out private registries such as us.com, under which
    // name.us.com would otherwise make all of us.com a seed.
    // An onion service has no publicly trusted certificate to log.
    if (SEED_TYPES.has(r.ioc_type) && reg && reg === host && !/\.onion$/.test(reg)) seeds.add(reg);
  }
  return { seeds, indexed };
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");
  const rules = await loadSuffixes();
  const { seeds } = fromIndex(rules);
  const store = readStore();
  let todo = named.length ? named.map((d) => d.toLowerCase()) : [...seeds];
  if (!force) todo = todo.filter((d) => !store.domains[d]);
  todo = todo.slice(0, limit);
  console.log(`${seeds.size} registrable operator domain(s), ${todo.length} to read`);
  const registrable = (h) => registrableDomain(h, rules);
  let n = 0;
  for (const domain of todo) {
    const got = await certificates(domain);
    store.domains[domain] = got.error
      ? { error: got.error, checked_at: new Date().toISOString().slice(0, 10) }
      : { ...ct.readSeed(domain, got.certs, registrable), certificates: got.certs.length, via: got.via, checked_at: new Date().toISOString().slice(0, 10) };
    writeFileAtomic(OUT, JSON.stringify(store, null, 1) + "\n");
    const r = store.domains[domain];
    if (r.siblings && r.siblings.length) console.log(`${domain}: ${r.siblings.length} other domain(s) on its certificates`);
    if (++n % 25 === 0) console.log(`  ${n}/${todo.length}`);
  }
}

async function rank() {
  const rules = await loadSuffixes();
  const { seeds, indexed } = fromIndex(rules);
  const store = readStore();
  const current = Object.fromEntries(Object.entries(store.domains).filter(([d]) => seeds.has(d)));
  const reg = (() => {
    try {
      return require("./data/domain-registration.json").domains || {};
    } catch {
      return {};
    }
  })();
  const registered = Object.fromEntries(Object.entries(reg).filter(([, r]) => r && r.created).map(([d, r]) => [d, r.created]));
  const l = ct.leads(current, indexed, registered);
  console.log(`${Object.keys(current).length} domain(s) read\n`);
  console.log(`Other domains on the same certificates, not indexed (${l.siblings.length}):`);
  for (const g of l.siblings) console.log(`  ${g.domain.padEnd(34)} with ${g.seeds.slice(0, 5).join(", ")}${g.seeds.length > 5 ? ` +${g.seeds.length - 5}` : ""}  (${g.names.slice(0, 3).join(" ")}; from ${g.first || "?"})`);
  console.log(`\nKeys shared by two or more indexed domains (${l.sharedKeys.length}):`);
  for (const k of l.sharedKeys) console.log(`  ${k.key.slice(0, 16)}…  ${k.seeds.join(", ")}`);
  console.log(`\nSubdomains of indexed domains, not indexed (${l.subdomains.length}):`);
  for (const s of l.subdomains) console.log(`  ${s.host.padEnd(44)} (${s.seed}, from ${s.first || "?"})`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (mode === "rank") rank().catch((e) => { console.error(e); process.exit(1); });
else {
  console.error("usage: ct-pivot.js collect [--force] [--limit N] [domain ...] | rank");
  process.exit(2);
}
