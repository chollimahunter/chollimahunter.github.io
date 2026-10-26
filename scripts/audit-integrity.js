#!/usr/bin/env node
/**
 * audit-integrity.js
 * ==============================================================
 * Structural checks over the indicator files, to be run beside
 * scripts/audit-indicators.js. That one asks whether a value belongs to an
 * operator; this one asks whether the data is internally consistent.
 *
 *   node scripts/audit-integrity.js     (or: npm run audit:integrity)
 *
 * Exits 1 when it finds anything. CI runs it after the build, so the
 * built-output checks at the end see the same _site the deploy would publish.
 *
 * It found, on its first run: two curated Aptos wallets under a shape the
 * normalizer did not know, two C2 endpoints storing host:port in an
 * ip_address, fifteen network addresses published as though they were hosts,
 * four email fragments with one- and two-digit local parts, and 1,417 records
 * from a credential dump this repository had already decided to hold.
 */
const fs = require("node:fs");
const path = require("node:path");

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

const problems = [];
const note = (label, detail) => problems.push({ label, detail });

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const IOCS = "src/_data/iocs";

const scraped = read(`${IOCS}/scraped-iocs.json`);
const config = read(`${IOCS}/scrape-sources.json`);
const index = require("../src/_data/iocIndex.js")();

// --- sources ---------------------------------------------------------------
const seen = new Map();
for (const s of config.sources) {
  if (seen.has(s.url)) note("duplicate source URL", s.url);
  seen.set(s.url, s);
  if (!s.publisher) note("source with no publisher", s.url);
  if (!s.campaign || !s.campaign.length) note("source with no campaign", s.url);
}
const declined = new Set(config.not_scraped.map((s) => s.url));
for (const url of seen.keys()) {
  if (declined.has(url)) note("URL in both sources and not_scraped", url);
}
for (const s of config.not_scraped) {
  if (!s.reason) note("declined source with no reason", s.url);
}

// --- records ---------------------------------------------------------------
let noSource = 0;
let noUrl = 0;
let noContext = 0;
const ids = new Set();
for (const r of scraped.records) {
  if (ids.has(r.id)) note("duplicate record id", `${r.id} (${r.value})`);
  ids.add(r.id);
  const sources = r.sources || [];
  if (!sources.length) noSource += 1;
  for (const s of sources) {
    if (!s.url) noUrl += 1;
    // A citation whose context was blanked on purpose (the window around an
    // address in a cracked-password table holds the password) is redacted,
    // not missing; see looksLikeCredentialContext in scrape-dprk-iocs.js.
    if (!s.context && s.context_origin !== "redacted") noContext += 1;
  }
}
if (noSource) note("records with no source at all", String(noSource));
if (noUrl) note("citations with no URL", String(noUrl));
if (noContext) note("citations with no context quote", String(noContext));
if (scraped.record_count !== scraped.records.length) {
  note("record_count disagrees with records.length", `${scraped.record_count} vs ${scraped.records.length}`);
}

// --- values round-trip through their own normalizer -------------------------
const n = require("./lib/ioc-normalize.js");
const NORM = {
  email_address: n.normalizeEmail,
  github_profile: n.normalizeGithub,
  linkedin_profile: n.normalizeLinkedin,
  domain: n.normalizeDomain,
  ip_address: n.normalizeIpv4,
  hosted_site: n.normalizeHostedSite,
  payload_url: n.normalizePayloadUrl,
  wallet_address: n.normalizeWallet,
  ens_name: n.normalizeEns,
  skype_account: n.normalizeSkype,
  alias: n.normalizeAlias,
  npm_package: (v) => n.normalizeNpmPackage(v, { keepVersion: true }),
};
let unstable = 0;
const examples = [];
for (const r of index.remote_workers.records) {
  const fn = NORM[r.ioc_type];
  if (!fn) continue;
  const again = fn(r.value);
  if (again !== r.value) {
    unstable += 1;
    if (examples.length < 6) examples.push(`${r.ioc_type} ${JSON.stringify(r.value)} -> ${JSON.stringify(again)}`);
  }
}
if (unstable) note("values that no longer normalize to themselves", `${unstable}\n      ` + examples.join("\n      "));

// --- persona photographs ----------------------------------------------------
const IMG = "src/assets/img/personas";
const onDisk = new Set(fs.existsSync(IMG) ? fs.readdirSync(IMG) : []);
const claimed = new Set();
for (const file of ["x-dossiers.json", "third-party-registries.json", "direct-observations.json"]) {
  const p = `${IOCS}/${file}`;
  if (!fs.existsSync(p)) continue;
  for (const e of read(p).dossiers || []) {
    const imgs = [e.photo, ...(e.photos || [])].filter((ph) => ph && ph.file);
    for (const ph of imgs) {
      const base = path.basename(ph.file);
      claimed.add(base);
      if (!onDisk.has(base)) note("dossier claims a photo the repo does not hold", `${e.persona} -> ${ph.file}`);
    }
  }
}
// Photographs published with no identifier are claimed by the section that
// renders them, not by a dossier.
for (const ph of read(`${IOCS}/x-dossiers.json`).unattributed_photos || []) {
  if (ph.file) claimed.add(path.basename(ph.file));
}
const orphans = [...onDisk].filter((f) => !claimed.has(f));
if (orphans.length) note("persona images no entry references", `${orphans.length}: ${orphans.slice(0, 8).join(", ")}${orphans.length > 8 ? " …" : ""}`);

// --- built output -----------------------------------------------------------
if (fs.existsSync("_site")) {
  const idx = read("_site/assets/data/ioc-index.json");
  // The shared search index carries the remote-worker records, the espionage
  // ones split out of that page but kept searchable on the cluster pages, and
  // the PolinRider repositories the repo scanner searches, and the EtherHiding
  // records the home page and cluster searches find.
  const searchableTotal =
    index.remote_workers.total + (index.totals.espionage || 0) + (index.totals.polinrider || 0) + (index.totals.etherhiding || 0);
  if (idx.records.length !== searchableTotal) {
    note("built payload disagrees with the index", `${idx.records.length} vs ${searchableTotal}`);
  }
  if (idx.v !== 2) note("payload is not v2", String(idx.v));
  for (const r of idx.records.slice(0, 400)) {
    for (const s of r.s || []) {
      if (idx.contexts[s[1]] === undefined) {
        note("context index out of range", `${r.v} -> ${s[1]}`);
        break;
      }
    }
  }
}

// --- report -----------------------------------------------------------------
if (!problems.length) {
  console.log("No integrity problems found.");
} else {
  console.log(`${problems.length} finding(s):\n`);
  for (const p of problems) console.log(`  ${p.label}: ${p.detail}`);
  // CI runs this after the build (see .github/workflows/ci.yml), so a finding
  // fails the check rather than waiting for someone to run it by hand.
  process.exitCode = 1;
}
