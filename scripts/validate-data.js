#!/usr/bin/env node
/**
 * validate-data.js — fail-closed structural validation for this site's data
 * ==========================================================================
 * Checks src/profiles/*.json, src/_data/hunts/hunts.json,
 * src/_data/taxonomy.json, src/_data/tradecraft.json,
 * src/_data/glossary.json and src/_data/iocs/*.json against the vocabulary
 * the site itself already uses — taxonomy labels, hunt tags, the campaign
 * merges in iocIndex.js — rather than a second, hand-kept copy of the rules.
 *
 * The IOC section reuses src/_data/iocIndex.js's own buildIndex() rather than
 * re-parsing every source file: that function IS the site's merge logic
 * (dossiers, rulesets, bulk datasets, normalization), so validating its
 * output checks exactly what the site would publish. Bulk-dataset-only
 * fields (entry_count, disclaimer, version pins) live on the raw dataset
 * files rather than on a merged record, so those are read separately.
 *
 * Exits 1 with one line per finding, 0 when clean. Prints a summary of how
 * many records were checked per file either way.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");

const ROOT = path.join(__dirname, "..");
const { huntSchemaProblems } = require("./lib/hunt-schema.js");
const { isReservedIpv4, normalizeEmail, normalizePhone, normalizeFileHash, normalizePayloadUrl } =require("./lib/ioc-normalize.js");

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

const findings = [];
const counts = {};
const fail = (file, id, field, problem) => findings.push(`${file} | ${id} | ${field} | ${problem}`);
// Warnings are printed but never fail the run: they mark an editorial decision
// still to be taken rather than a record that contradicts a rule.
const warnings = [];
const warn = (file, id, field, problem) => warnings.push(`${file} | ${id} | ${field} | ${problem}`);
const bump = (file, n = 1) => (counts[file] = (counts[file] || 0) + n);
const { candidateConfidence, candidateSignals } = require("./lib/candidate-confidence.js");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

// --- Shared primitives ------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TODAY = new Date().toISOString().slice(0, 10);

function isRealIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Date rolls an invalid day/month forward (2026-02-30 -> 2026-03-02) rather
  // than rejecting it, so the round trip is what catches a bad calendar date.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** ISO format + real calendar date, optionally also rejecting a future date. */
function checkDate(file, id, field, value, { future = false } = {}) {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string" || !isRealIsoDate(value)) {
    return fail(file, id, field, `"${value}" is not a real ISO YYYY-MM-DD date`);
  }
  if (future && value > TODAY) fail(file, id, field, `"${value}" is after today (${TODAY})`);
}
const isHttpUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v);
const nonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const kebabCase = (v) => typeof v === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v);
/** A prose field may be one string or an array of paragraphs (see .eleventy.js `paragraphs`). */
function hasProse(v) {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((x) => typeof x === "string" && x.trim().length > 0);
  return false;
}
/** Recursively flags any string field still carrying a leftover "TODO". */
function findTodo(value, hits, where) {
  if (value == null) return;
  if (typeof value === "string") {
    if (value.includes("TODO")) hits.push(where);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findTodo(v, hits, `${where}[${i}]`));
  } else if (typeof value === "object") {
    for (const k of Object.keys(value)) findTodo(value[k], hits, `${where}.${k}`);
  }
}
function checkDuplicates(file, field, ids) {
  const seen = new Map();
  for (const id of ids) if (id) seen.set(id, (seen.get(id) || 0) + 1);
  for (const [id, n] of seen) if (n > 1) fail(file, id, field, `duplicated ${n} times`);
}

// --- Profiles ----------------------------------------------------------------

const CONFIDENCE_LEVELS = new Set(["confirmed", "high", "medium", "low"]);
const taxonomy = readJson("src/_data/taxonomy.json");
const taxonomyLabels = new Set(taxonomy.map((t) => t.label));

function checkProfiles() {
  const file = "src/profiles";
  const dir = path.join(ROOT, "src", "profiles");
  for (const filename of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const slug = filename.replace(/\.json$/, "");
    const p = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8"));
    const id = p.slug || slug;
    bump(file);

    if (p.slug !== slug) fail(file, id, "slug", `slug "${p.slug}" does not match filename "${filename}"`);
    if (!CONFIDENCE_LEVELS.has(p.confidence_level)) {
      fail(file, id, "confidence_level", `"${p.confidence_level}" is not confirmed/high/medium/low`);
    }
    if (!Array.isArray(p.sources) || p.sources.length === 0) {
      fail(file, id, "sources", "sources[] is empty");
    } else {
      p.sources.forEach((s, i) => {
        if (!nonEmptyString(s.title)) fail(file, id, `sources[${i}].title`, "missing or empty");
        if (!isHttpUrl(s.url)) fail(file, id, `sources[${i}].url`, `"${s.url}" does not start with http(s)://`);
        if (!nonEmptyString(s.publisher)) fail(file, id, `sources[${i}].publisher`, "missing or empty");
        checkDate(file, id, `sources[${i}].date`, s.date, { future: true });
      });
    }
    for (const label of p.cluster_taxonomy || []) {
      if (!taxonomyLabels.has(label)) fail(file, id, "cluster_taxonomy", `"${label}" is not a label in taxonomy.json`);
    }
    checkDate(file, id, "last_updated", p.last_updated, { future: true });
    if (!p.last_updated) fail(file, id, "last_updated", "missing");

    if (p.photo_slot && p.photo_slot.image_path) {
      const imgPath = path.join(ROOT, "src", p.photo_slot.image_path.replace(/^\//, ""));
      if (!fs.existsSync(imgPath)) fail(file, id, "photo_slot.image_path", `"${p.photo_slot.image_path}" does not exist under src/`);
      if (!p.name_korean && !p.name_korean_not_applicable) {
        fail(file, id, "name_korean", "profile has a photo but no name_korean or name_korean_not_applicable");
      }
    }
    if (p.name_korean_provenance && !["cited", "reconstructed"].includes(p.name_korean_provenance)) {
      fail(file, id, "name_korean_provenance", `"${p.name_korean_provenance}" is not cited/reconstructed`);
    }
    if ((p.aliases || []).includes(p.display_name)) {
      fail(file, id, "aliases", `aliases[] duplicates display_name "${p.display_name}"`);
    }
    const todoHits = [];
    findTodo(p, todoHits, id);
    for (const where of todoHits) fail(file, id, where, 'leftover "TODO" in field value');
  }
}

// --- Hunts ---------------------------------------------------------------

const HUNT_TYPES = new Set(["IOC Hunt", "TTP Hunt", "Behavioral Hunt"]);
const QUERY_ORIGINS = new Set(["reproduced", "authored"]);

function checkHunts() {
  const file = "src/_data/hunts/hunts.json";
  const hunts = readJson(file);
  const huntTagsKnown = new Set(taxonomy.flatMap((t) => t.hunt_tags || []));
  checkDuplicates(file, "id", hunts.map((h) => h.id));

  for (const hunt of hunts) {
    const id = hunt.id;
    bump(file);
    if (!kebabCase(hunt.id)) fail(file, id, "id", `"${hunt.id}" is not kebab-case`);
    if (!HUNT_TYPES.has(hunt.hunt_type)) fail(file, id, "hunt_type", `"${hunt.hunt_type}" is not a known hunt_type`);
    if (!CONFIDENCE_LEVELS.has(hunt.confidence_level)) {
      fail(file, id, "confidence_level", `"${hunt.confidence_level}" is not confirmed/high/medium/low`);
    }
    (hunt.queries || []).forEach((q, i) => {
      if (!QUERY_ORIGINS.has(q.origin)) fail(file, id, `queries[${i}].origin`, `"${q.origin}" is not reproduced/authored`);
      if (!nonEmptyString(q.query)) fail(file, id, `queries[${i}].query`, "missing or empty");
      if (q.origin === "reproduced" && (!nonEmptyString(q.source) || !isHttpUrl(q.source_url))) {
        fail(file, id, `queries[${i}]`, "origin is reproduced but source/source_url is missing or not http(s)");
      }
    });
    // platforms, logic, and each query's platform, language, note and tuning.
    for (const p of huntSchemaProblems(hunt)) fail(file, id, p.field, p.problem);
    if (!Array.isArray(hunt.sources) || hunt.sources.length === 0) {
      fail(file, id, "sources", "sources[] is empty");
    } else {
      hunt.sources.forEach((s, i) => {
        if (!isHttpUrl(s.url)) fail(file, id, `sources[${i}].url`, `"${s.url}" does not start with http(s)://`);
      });
    }
    checkDate(file, id, "last_updated", hunt.last_updated);
    if (!hunt.last_updated) fail(file, id, "last_updated", "missing");
    if (!Array.isArray(hunt.campaign_tags) || hunt.campaign_tags.length === 0) {
      fail(file, id, "campaign_tags", "campaign_tags[] is empty");
    } else if (!hunt.campaign_tags.some((t) => huntTagsKnown.has(t))) {
      fail(file, id, "campaign_tags", `none of ${JSON.stringify(hunt.campaign_tags)} match any taxonomy hunt_tags`);
    }
  }

  const redirects = readJson("src/_data/hunts/redirects.json");
  const huntIds = new Set(hunts.map((h) => h.id));
  for (const r of redirects) {
    bump("src/_data/hunts/redirects.json");
    if (!huntIds.has(r.to)) fail("src/_data/hunts/redirects.json", r.from, "to", `"${r.to}" is not a hunt id`);
  }
}

// --- Taxonomy, tradecraft, glossary ---------------------------------------

function checkTaxonomy() {
  const file = "src/_data/taxonomy.json";
  checkDuplicates(file, "id", taxonomy.map((t) => t.id));
  checkDuplicates(file, "label", taxonomy.map((t) => t.label));
  for (const tag of taxonomy) {
    bump(file);
    if (!kebabCase(tag.id)) fail(file, tag.id, "id", `"${tag.id}" is not a valid slug`);
    (tag.further_reading || []).forEach((fr, i) => {
      if (!nonEmptyString(fr.title)) fail(file, tag.id, `further_reading[${i}].title`, "missing or empty");
      if (!isHttpUrl(fr.url)) fail(file, tag.id, `further_reading[${i}].url`, `"${fr.url}" does not start with http(s)://`);
      if (!nonEmptyString(fr.publisher)) fail(file, tag.id, `further_reading[${i}].publisher`, "missing or empty");
      if (!nonEmptyString(fr.date)) fail(file, tag.id, `further_reading[${i}].date`, "missing or empty");
      else checkDate(file, tag.id, `further_reading[${i}].date`, fr.date);
    });
    for (const c of tag.indicator_campaigns || []) {
      if (typeof c !== "string" || !c.trim()) fail(file, tag.id, "indicator_campaigns", `"${c}" is not a non-empty string`);
    }
  }
}

function checkTradecraft() {
  const file = "src/_data/tradecraft.json";
  const tc = readJson(file);
  const sourceKeys = new Set(Object.keys(tc.sources || {}));
  const used = new Set();
  for (const cat of tc.categories || []) {
    for (const ind of cat.indicators || []) {
      bump(file);
      for (const key of ind.sources || []) {
        used.add(key);
        if (!sourceKeys.has(key)) fail(file, ind.indicator, "sources", `key "${key}" is not in the sources map`);
      }
    }
  }
  for (const key of sourceKeys) if (!used.has(key)) fail(file, key, "sources", "source key is never used by an indicator");
}

function checkGlossary() {
  const file = "src/_data/glossary.json";
  const glossary = readJson(file);
  checkDuplicates(file, "term", glossary.map((t) => t.term));
  const huntIds = new Set(readJson("src/_data/hunts/hunts.json").map((h) => h.id));
  const taxonomyIds = new Set(taxonomy.map((t) => t.id));
  for (const term of glossary) {
    bump(file);
    const url = term.see && term.see.url;
    if (!url) continue;
    const huntMatch = /^\/hunts\/([^/]+)\/$/.exec(url);
    const clusterMatch = /^\/clusters\/([^/]+)\/$/.exec(url);
    if (huntMatch && !huntIds.has(huntMatch[1])) fail(file, term.term, "see.url", `"${url}" does not match a hunt id`);
    if (clusterMatch && !taxonomyIds.has(clusterMatch[1])) fail(file, term.term, "see.url", `"${url}" does not match a taxonomy id`);
  }
}

// --- IOCs ------------------------------------------------------------------
// Validated off the site's own merged index plus the raw bulk-dataset files
// (entry_count/disclaimer/version-pinning are dataset-file-only fields that
// do not survive into a merged record).

// Mirrors iocIndex.js's own ESPIONAGE_CAMPAIGNS and MERGED_CAMPAIGN_LABELS —
// kept in sync by hand since that file exports neither. "NullReceiver" and
// "PolinRider" are campaign labels a bulk dataset or ruleset uses that
// taxonomy's indicator_campaigns alone does not fully cover.
const ESPIONAGE_CAMPAIGNS = ["Lazarus Group", "Kimsuky", "APT37", "Konni", "APT38", "Andariel", "Moonstone Sleet", "DPRK (cluster unattributed)"];
const KNOWN_CAMPAIGN_LABELS = new Set([
  ...taxonomy.flatMap((t) => t.indicator_campaigns || []),
  ...ESPIONAGE_CAMPAIGNS,
  // "EtherHiding" alone labels a value with no published DPRK link, which
  // iocIndex.js leaves unfolded (see attribution_doubt there).
  "EtherHiding / UNC5342", "EtherHiding", "PolinRider", "NullReceiver",
]);

function checkIpAddress(file, id, value) {
  const kind = net.isIP(value);
  if (kind === 0) return fail(file, id, "value", `"${value}" is not a valid IPv4/IPv6 address`);
  if (kind === 4 && isReservedIpv4(value)) fail(file, id, "value", `"${value}" is a private/loopback/reserved IPv4 address`);
  if (kind === 6) {
    const v = value.toLowerCase();
    const reserved = v === "::1" || v === "::" || v.startsWith("fe80:") || /^f[c-d][0-9a-f]{2}:/.test(v) || v.startsWith("::ffff:");
    if (reserved) fail(file, id, "value", `"${value}" is a private/loopback/reserved IPv6 address`);
  }
}

// Which indexed records the enrichers have never answered for. Warn-only for
// now: this becomes a failure once the enrich-refresh workflow has run clean
// and the gaps it can close are closed.
function checkEnrichmentCoverage(idx) {
  const readItems = (name, pick) => {
    try {
      return pick(JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "data", name), "utf8")));
    } catch {
      return null;
    }
  };
  const lookedUp = readItems("ip-lookups.json", (d) => new Set(Object.keys(d.addresses || {})));
  const statused = readItems(
    "malware-status.json",
    (d) => new Set((d.items || []).map((x) => `${x.type}|${String(x.value).toLowerCase()}`))
  );
  const MALWARE_TYPES = new Set(["malicious_repository", "npm_package", "pypi_package"]);
  let ips = 0, ipsMissing = 0, malware = 0, malwareMissing = 0;
  for (const r of idx.records) {
    if (r.ioc_type === "ip_address") {
      ips += 1;
      if (!lookedUp || !lookedUp.has(r.value)) ipsMissing += 1;
    } else if (MALWARE_TYPES.has(r.ioc_type)) {
      malware += 1;
      if (!statused || !statused.has(`${r.ioc_type}|${String(r.value).toLowerCase()}`)) malwareMissing += 1;
    }
  }
  console.error(`validate-data: enrichment coverage: ip_address ${ips - ipsMissing} of ${ips} in ip-lookups.json, malware ${malware - malwareMissing} of ${malware} in malware-status.json`);
  if (ipsMissing) console.error(`validate-data: warning: ${ipsMissing} ip_address record(s) have no entry in scripts/data/ip-lookups.json (run scripts/enrich-ips.js)`);
  if (malwareMissing) console.error(`validate-data: warning: ${malwareMissing} malicious_repository / npm_package / pypi_package record(s) have no entry in scripts/data/malware-status.json (run scripts/enrich-malware-status.js)`);
}

function checkIocRecords() {
  const file = "src/_data/iocs (merged index)";
  let idx;
  try {
    idx = require("../src/_data/iocIndex.js")();
  } catch (err) {
    fail(file, "-", "(build)", `the index did not build: ${err.message}`);
    return;
  }
  checkEnrichmentCoverage(idx);

  // A value filed under two types that name the same thing must have been
  // folded into one record by iocIndex.js; see FOLDED_TYPES there.
  const { FOLDED_TYPES } = require("../src/_data/iocIndex.js");
  const typesByValue = new Map();
  for (const r of idx.records) {
    const key = String(r.value).toLowerCase();
    if (!typesByValue.has(key)) typesByValue.set(key, new Set());
    typesByValue.get(key).add(r.ioc_type);
  }
  for (const [value, types] of typesByValue) {
    for (const [from, to] of Object.entries(FOLDED_TYPES)) {
      if (types.has(from) && types.has(to)) fail(file, value, "ioc_type", `published as both ${from} and ${to}`);
    }
  }

  for (const r of idx.records) {
    bump(file);
    if (!nonEmptyString(r.ioc_type)) fail(file, r.id, "ioc_type", "missing or empty");
    if (typeof r.value !== "string" || r.value.length === 0 || r.value.trim() !== r.value) {
      fail(file, r.id, "value", `"${r.value}" is empty or has leading/trailing whitespace`);
    }
    if (!Array.isArray(r.campaign)) {
      fail(file, r.id, "campaign", "is not an array");
    } else {
      for (const c of r.campaign) {
        if (typeof c !== "string") fail(file, r.id, "campaign", `"${c}" is not a string`);
        else if (!KNOWN_CAMPAIGN_LABELS.has(c)) fail(file, r.id, "campaign", `"${c}" is not a known campaign label`);
      }
    }
    if (r.attribution_doubt != null && !nonEmptyString(r.attribution_doubt)) {
      fail(file, r.id, "attribution_doubt", "is set but not a non-empty string");
    }
    const sources = r.sources || [];
    // A first-party observation is published by this site itself, so its
    // citation names Chollima Hunter as the publisher and has no URL to give:
    // the site is the source. Every other citation must link to its report.
    if (!sources.some((s) => isHttpUrl(s.url))) {
      const firstParty = sources.length > 0 && sources.every((s) => s.publisher === "Chollima Hunter");
      if (!firstParty) fail(file, r.id, "sources", "no source has an http(s) url");
    }
    checkDate(file, r.id, "first_seen", r.first_seen);
    checkDate(file, r.id, "last_seen", r.last_seen);
    sources.forEach((s, i) => checkDate(file, r.id, `sources[${i}].published`, s.published));

    if (r.ioc_type === "email_address") {
      const n = normalizeEmail(r.value);
      if (!n) fail(file, r.id, "value", `"${r.value}" does not normalize as a valid email address`);
      else if (n !== r.value) fail(file, r.id, "value", `"${r.value}" is not the canonical (lowercase, Gmail-folded) form; expected "${n}"`);
    } else if (r.ioc_type === "phone_number") {
      const n = normalizePhone(r.value);
      if (!n) fail(file, r.id, "value", `"${r.value}" does not normalize to E.164`);
      else if (n !== r.value) fail(file, r.id, "value", `"${r.value}" is not E.164; expected "${n}"`);
    } else if (r.ioc_type === "file_hash") {
      const n = normalizeFileHash(r.value);
      if (!n) fail(file, r.id, "value", `"${r.value}" is not a 32/40/64-char hex hash, or is a known empty-file digest`);
      else if (n !== r.value) fail(file, r.id, "value", `"${r.value}" is not lowercase; expected "${n}"`);
    } else if (r.ioc_type === "ip_address") {
      checkIpAddress(file, r.id, r.value);
    } else if (r.ioc_type === "payload_url") {
      const n = normalizePayloadUrl(r.value);
      if (!n) fail(file, r.id, "value", `"${r.value}" is not a URL with a path (a bare host is not a payload URL)`);
      else if (n !== r.value) fail(file, r.id, "value", `"${r.value}" is not the canonical form; expected "${n}"`);
    }
  }
}

/** Whether a bulk-dataset entry is a package name pinned to a version (name@version). */
function isVersionPinned(entry) {
  if (typeof entry !== "string") return false;
  if (entry.startsWith("@")) {
    const parts = entry.slice(1).split("@");
    return parts.length === 2 && parts[0].includes("/") && parts[1].length > 0;
  }
  const at = entry.lastIndexOf("@");
  return at > 0 && entry.slice(at + 1).length > 0;
}

const BULK_DATASET_FILES = [
  "src/_data/iocs/itworker-datasets.json",
  "src/_data/iocs/osm-malicious-package-versions.json",
  "src/_data/iocs/malicious-package-versions.json",
  "src/_data/iocs/polinrider-affected-repos.json",
];
const PACKAGE_TYPES = new Set(["npm_package", "pypi_package"]);

function checkBulkDatasets() {
  const allDatasetIds = [];
  for (const relFile of BULK_DATASET_FILES) {
    for (const d of readJson(relFile)) {
      bump(relFile);
      allDatasetIds.push(d.dataset_id);
      if (!Array.isArray(d.entries) || d.entry_count !== d.entries.length) {
        fail(relFile, d.dataset_id, "entry_count", `entry_count (${d.entry_count}) does not equal entries.length (${(d.entries || []).length})`);
      }
      if (!hasProse(d.disclaimer)) fail(relFile, d.dataset_id, "disclaimer", "missing or empty");
      if (!d.source || !isHttpUrl(d.source.url)) fail(relFile, d.dataset_id, "source.url", `"${d.source && d.source.url}" does not start with http(s)://`);
      if (PACKAGE_TYPES.has(d.ioc_type)) {
        for (const entry of d.entries || []) {
          if (!isVersionPinned(entry)) fail(relFile, d.dataset_id, "entries", `"${entry}" is not version-pinned as name@version`);
        }
      }
      if (d.confidence_level !== undefined && !CONFIDENCE_LEVELS.has(d.confidence_level)) {
        fail(relFile, d.dataset_id, "confidence_level", `"${d.confidence_level}" is not confirmed/high/medium/low`);
      }
    }
  }
  checkDuplicates("bulk datasets (dataset_id)", "dataset_id", allDatasetIds);
}

const RULESET_FILES = ["src/_data/iocs/repo-scan-ruleset.json", "src/_data/iocs/etherhiding-watchlist.json"];

function checkRulesets() {
  const allRulesetIds = [];
  for (const relFile of RULESET_FILES) {
    for (const e of readJson(relFile)) {
      bump(relFile);
      allRulesetIds.push(e.id);
      if (e.confidence_level !== undefined && !CONFIDENCE_LEVELS.has(e.confidence_level)) {
        fail(relFile, e.id, "confidence_level", `"${e.confidence_level}" is not confirmed/high/medium/low`);
      }
    }
  }
  checkDuplicates("rulesets (entry id)", "id", allRulesetIds);
}

// The candidate table shows these values in one column each, so each field
// takes one form: account_created is ISO (YYYY-MM, or YYYY-MM-DD where the
// day is known) and confidence is one of the three levels the badge colours.
function checkCandidates() {
  const file = "src/_data/iocs/candidates.json";
  const queue = readJson(file);
  // Every telephone number the curated files hold for a pipu.cc listing, so a
  // candidate row that links the listing carries its number too. The Line
  // type column reads "none published" for a row with no number, which is
  // false when the listing it cites printed one.
  const phonesByListing = {};
  for (const rel of ["src/_data/iocs/direct-observations.json", "src/_data/iocs/x-dossiers.json"]) {
    const doc = readJson(rel);
    for (const e of [...(doc.dossiers || []), ...(doc.unattributed || [])]) {
      for (const post of e.posts || []) {
        const m = /pipu\.cc\/.*item_id=(\d+)/.exec(post.url || "");
        if (!m) continue;
        for (const i of e.indicators || []) {
          if (i.ioc_type === "phone_number") (phonesByListing[m[1]] = phonesByListing[m[1]] || new Set()).add(i.value);
        }
      }
    }
  }
  const digits = (v) => String(v).replace(/[^\d+]/g, "");
  for (const c of queue.candidates || []) {
    bump(file);
    // Only rows the site shows live in the public file; leads and false
    // positives are kept in _drafts/private/candidates.json by scan-candidates.js.
    if (!["under-review", "confirmed"].includes(c.status)) {
      fail(file, c.slug, "status", `"${c.status}" rows belong in _drafts/private/candidates.json`);
    }
    const f = c.facts || {};
    const held = new Set((f.indicators || []).filter((i) => i.type === "phone_number").map((i) => digits(i.value)));
    for (const [, item] of JSON.stringify(c).matchAll(/pipu\.cc\/[^"]*item_id=(\d+)/g)) {
      for (const phone of phonesByListing[item] || []) {
        if (!held.has(digits(phone))) {
          fail(file, c.slug, "facts.indicators", `links pipu listing ${item}, whose number ${phone} this index holds, but does not carry it`);
        }
      }
    }
    if (f.account_created != null && !/^\d{4}-\d{2}(-\d{2})?$/.test(String(f.account_created))) {
      fail(file, c.slug, "facts.account_created", `"${f.account_created}" is not YYYY-MM or YYYY-MM-DD`);
    }
    if (f.confidence != null && !["high", "medium", "low"].includes(f.confidence)) {
      fail(file, c.slug, "facts.confidence", `"${f.confidence}" is not high/medium/low`);
    }
    // Confidence is computed from the row's signals (scripts/lib/candidate-
    // confidence.js), so a signal added without revisiting it is caught here.
    if (c.status !== "false-positive") {
      const want = candidateConfidence(candidateSignals(c));
      if (f.confidence !== want) {
        fail(file, c.slug, "facts.confidence", `"${f.confidence}" but its signals score "${want}"`);
      }
    }
  }
}

// --- Enrichment files ---------------------------------------------------
// Each file under scripts/data/ the build reads, against the shape its reader
// expects. A missing file is allowed (the build renders without it); one that
// is present and does not parse, or has the wrong shape, is a finding.

function checkEnrichmentFiles() {
  const { SHAPES } = require("./lib/enrichment-shapes.js");
  for (const [name, problemsOf] of Object.entries(SHAPES)) {
    const rel = `scripts/data/${name}`;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    bump(rel);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      fail(rel, "-", "(file)", `is not valid JSON: ${err.message}`);
      continue;
    }
    for (const problem of problemsOf(doc)) fail(rel, "-", "(shape)", problem);
  }
}

// --- Sealed lists --------------------------------------------------------
// Withheld values are published only as hashes (scripts/seal-private-lists.js),
// so an entry carrying anything but `sealed` would print a value the site
// decided not to. Run `npm run seal` to move it to _drafts/private/.

function checkSealedLists() {
  const SEALED = /^[0-9a-f]{64}$/;
  const isSealed = (e) => e && Object.keys(e).length === 1 && SEALED.test(e.sealed);
  const sourcesFile = "src/_data/iocs/scrape-sources.json";
  for (const source of readJson(sourcesFile).sources || []) {
    for (const entry of source.exclude || []) {
      bump(sourcesFile);
      if (!isSealed(entry)) fail(sourcesFile, source.url, "exclude", "entry is not sealed; run npm run seal");
    }
  }
  const fpFile = "scripts/data/false-positives.json";
  for (const entry of readJson(fpFile).values || []) {
    bump(fpFile);
    if (!isSealed(entry)) fail(fpFile, "-", "values", "entry is not sealed; run npm run seal");
  }
}

// --- Run ---------------------------------------------------------------

checkSealedLists();
checkEnrichmentFiles();
checkProfiles();
checkHunts();
checkTaxonomy();
checkTradecraft();
checkGlossary();
checkIocRecords();
checkBulkDatasets();
checkRulesets();
checkCandidates();

console.log("validate-data: checked " + Object.entries(counts).map(([f, n]) => `${f} (${n})`).join(", "));

if (warnings.length) {
  console.error(`
validate-data: ${warnings.length} warning(s), not failing:
`);
  for (const w of warnings) console.error(`  ${w}`);
}
if (findings.length) {
  console.error(`\nvalidate-data: ${findings.length} finding(s):\n`);
  for (const f of findings) console.error("  " + f);
  process.exit(1);
} else {
  console.log("validate-data: clean.");
  process.exit(0);
}
