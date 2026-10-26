#!/usr/bin/env node
/**
 * enrich-domains.js
 * ==============================================================
 * When each domain indicator was registered, and with whom, from the
 * registry's own RDAP record. A C2 domain registered days before it was first
 * written on-chain reads very differently from one registered fifteen years
 * ago, which is more likely a compromised site or a parked value.
 *
 * Run manually, from the repository root, after adding domain indicators:
 *   node scripts/enrich-domains.js            # domains with no entry yet
 *   node scripts/enrich-domains.js --refresh  # every domain again
 *
 * Only a value that is itself a registrable domain is looked up: example.com
 * or example.co.uk, never api.example.com or name.trycloudflare.com. A
 * subdomain's registration date is its parent's, which for a platform
 * subdomain (trycloudflare.com, cloudapp.azure.com, vercel.app) says nothing
 * about the operator. Which values are registrable comes from the ICANN
 * section of the Public Suffix List, downloaded each run.
 *
 * Sources:
 *   1. The Public Suffix List, https://publicsuffix.org/list/.
 *   2. IANA's RDAP bootstrap file, which names each TLD's RDAP server.
 *   3. That server's domain record: the registration, expiration and last
 *      changed events, the registrar's name and the status codes.
 *
 * Output: scripts/data/domain-registration.json, keyed by domain. Read at
 * build time by src/_data/iocIndex.js, which attaches a `registration` block
 * to each domain, hosted_site and personal_site record whose host has an
 * entry; partials/ioc-detail.njk renders it. A domain the registry answers
 * 404 for is kept as `registered: false`: it had lapsed or been deleted when
 * it was looked up. A TLD with no RDAP server gets no entry at all, since
 * "not looked up" and "not registered" are different claims.
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

const OUT_PATH = path.join(__dirname, "data", "domain-registration.json");
const PSL_URL = "https://publicsuffix.org/list/public_suffix_list.dat";
const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const HOST_TYPES = new Set(["domain", "hosted_site", "personal_site"]);
const UA = { "User-Agent": "ChollimaHunterEnrich/1.0", Accept: "application/rdap+json, application/json" };

const refresh = process.argv.includes("--refresh");
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * The ICANN section of the Public Suffix List, as three sets: plain, wildcard
 * and exception. The private section is left out on purpose: it lists
 * platforms such as vercel.app as suffixes, which would make every
 * name.vercel.app look registrable when it is a subdomain of the platform's.
 */
async function loadSuffixes() {
  const res = await fetch(PSL_URL, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Public Suffix List returned ${res.status}`);
  const rules = { plain: new Set(), wildcard: new Set(), exception: new Set() };
  for (const raw of (await res.text()).split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (line.includes("===end icann domains===")) break;
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("!")) rules.exception.add(line.slice(1));
    else if (line.startsWith("*.")) rules.wildcard.add(line.slice(2));
    else rules.plain.add(line);
  }
  return rules;
}

/** The registrable domain (eTLD+1) a host belongs to, by the PSL algorithm. */
function registrableDomain(host, rules) {
  const labels = host.split(".");
  if (labels.length < 2 || /^\d+(\.\d+){3}$/.test(host)) return null;
  let suffixLength = 1;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    const parent = labels.slice(i + 1).join(".");
    if (rules.exception.has(candidate)) { suffixLength = labels.length - i - 1; break; }
    if (rules.plain.has(candidate) || (parent && rules.wildcard.has(parent))) { suffixLength = labels.length - i; break; }
  }
  if (suffixLength >= labels.length) return null;
  return labels.slice(labels.length - suffixLength - 1).join(".");
}

async function loadBootstrap() {
  const res = await fetch(BOOTSTRAP_URL, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`RDAP bootstrap returned ${res.status}`);
  const servers = new Map();
  for (const [tlds, urls] of (await res.json()).services) {
    const url = urls.find((u) => u.startsWith("https://")) || urls[0];
    for (const tld of tlds) servers.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
  }
  return servers;
}

function vcardName(entity) {
  const fn = ((entity.vcardArray || [])[1] || []).find((f) => f[0] === "fn");
  return fn ? String(fn[3]).trim() || null : null;
}

function parseRecord(json) {
  const when = (action) => {
    const event = (json.events || []).find((e) => e.eventAction === action);
    return event && event.eventDate ? String(event.eventDate).slice(0, 10) : null;
  };
  const registrar = (json.entities || []).find((e) => (e.roles || []).includes("registrar"));
  return {
    registered: true,
    created: when("registration"),
    expires: when("expiration"),
    updated: when("last changed"),
    registrar: registrar ? vcardName(registrar) : null,
    status: (json.status || []).map(String),
  };
}

async function lookup(domain, server) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${server}domain/${domain}`, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (res.status === 404) return { registered: false };
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("Retry-After"));
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 15 * (attempt + 1)) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${server} returned ${res.status}`);
    return parseRecord(await res.json());
  }
  throw new Error(`${server}: retries exhausted`);
}

function loadLookups() {
  if (!fs.existsSync(OUT_PATH)) {
    return {
      _comment:
        "When each registrable domain indicator was registered, from the registry's RDAP record. Written by scripts/enrich-domains.js; read at build time by src/_data/iocIndex.js. Subdomains are never looked up, and a domain with no entry was not looked up.",
      checked: today,
      domains: {},
    };
  }
  return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
}

async function main() {
  const index = require("../src/_data/iocIndex.js")();
  const [rules, servers] = await Promise.all([loadSuffixes(), loadBootstrap()]);

  // The EtherHiding parked values are not indicators, but the tracker lists
  // them and their age is part of why they read as parked.
  const reviewPath = path.join(__dirname, "data", "etherhiding-c2-review.json");
  const reviewed = fs.existsSync(reviewPath) ? Object.keys(JSON.parse(fs.readFileSync(reviewPath, "utf8")).hosts || {}) : [];

  const domains = new Set();
  let subdomains = 0;
  const values = [...index.records.filter((r) => HOST_TYPES.has(r.ioc_type)).map((r) => r.value), ...reviewed];
  for (const value of values) {
    const host = hostOf(value);
    if (!host) continue;
    const registrable = registrableDomain(host, rules);
    if (registrable === host) domains.add(host);
    else if (registrable) subdomains++;
  }

  const lookups = loadLookups();
  const pending = [...domains].filter((d) => refresh || !lookups.domains[d]);
  console.log(`${domains.size} registrable domains (${subdomains} subdomain values skipped), ${pending.length} to look up.`);

  let failed = 0;
  let noRdap = 0;
  for (const [i, domain] of pending.entries()) {
    const server = servers.get(domain.slice(domain.lastIndexOf(".") + 1));
    if (!server) { noRdap++; continue; }
    try {
      lookups.domains[domain] = { ...(await lookup(domain, server)), checked: today };
    } catch (err) {
      console.error(`${domain}: ${err.message}`);
      failed++;
    }
    if ((i + 1) % 50 === 0) {
      writeFileAtomic(OUT_PATH, JSON.stringify(lookups, null, 2) + "\n");
      console.log(`${i + 1} of ${pending.length} looked up`);
    }
    await sleep(250);
  }

  lookups.checked = today;
  lookups.domains = Object.fromEntries(Object.entries(lookups.domains).sort(([a], [b]) => a.localeCompare(b)));
  writeFileAtomic(OUT_PATH, JSON.stringify(lookups, null, 2) + "\n");
  if (noRdap) console.log(`${noRdap} domains are on TLDs with no RDAP server and were left without an entry.`);
  if (failed) console.log(`${failed} lookups failed and will be retried next run.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { registrableDomain, parseRecord };
