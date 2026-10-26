#!/usr/bin/env node
/**
 * scan-candidates.js
 * ==============================================================
 * Intake tool for src/_data/iocs/candidates.json, the review queue
 * behind /remote-workers/candidates/ ("Potential DPRK Profiles").
 *
 * WHAT THIS SCRIPT DOES NOT DO, AND WHY
 * --------------------------------------------------------------
 * It does not query a search engine and it does not touch linkedin.com. Two
 * reasons, both structural rather than incidental:
 *
 *   1. LinkedIn returns an authwall (HTTP 999) to any unauthenticated request,
 *      the same constraint documented at the top of enrich-linkedin-accounts.js.
 *      There is no way to open a profile from this script without a signed-in
 *      session, and signing in from an automated script is exactly the
 *      LinkedIn-login path the task this script serves was told not to build.
 *   2. A Google dork is a search query, not a stable API this repository has
 *      credentials for. Running one programmatically means scraping a search
 *      engine's results page, which is its own ToS problem and produces
 *      results that vary by session, geography and time in ways that make a
 *      "scan" silently non-reproducible.
 *
 * So the design puts a human (or an agent driving a browser/search tool) in
 * the loop for discovery, and this script is the deterministic half: it holds
 * the canonical heuristic and dork definitions (--list-dorks), and it is the
 * single enforcement point for the two rules that must never be violated by
 * hand-editing the JSON directly -- a URL already judged false-positive is
 * never re-added, and a URL already a confirmed indicator elsewhere on the
 * site is never duplicated into this queue.
 *
 * USAGE
 * --------------------------------------------------------------
 *   node scripts/scan-candidates.js --list-dorks
 *     Prints every heuristic and dork query defined in the data file, for a
 *     human (or an agent using WebSearch) to run by hand.
 *
 *   node scripts/scan-candidates.js --add <url> \
 *       --dork <dork-id> --indicators <comma,separated,heuristic,ids> \
 *       [--note "free text"]
 *     Adds one new candidate at status "lead". Idempotent: a URL already in
 *     the queue (any status) or already a confirmed indicator elsewhere on
 *     the site is skipped, not duplicated.
 *
 *   node scripts/scan-candidates.js --import <path-to-json>
 *     Same as --add, for a JSON array of
 *     { "url", "dork", "indicators": [...], "note" } objects -- the shape an
 *     agent that ran several dorks in one pass can hand back in one call.
 *
 *   node scripts/scan-candidates.js --check
 *     No writes. Reports counts by status and flags any structural problem
 *     (a false-positive with no reason, a candidate whose matched_indicators
 *     or found_by_dork key does not exist in the definitions).
 *
 * Every subcommand exits non-zero on a data problem so it can be wired into
 * the same review discipline the rest of this repository's scripts use.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { hasPrivateData, privatePath, readPrivateJson } = require("./lib/private-data.js");

const { normalizeLinkedin, safeDecode } = require("./lib/ioc-normalize.js");

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

const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "src", "_data", "iocs", "candidates.json");

const VALID_STATUSES = ["lead", "under-review", "confirmed", "false-positive"];

// The public file holds only the rows the site shows. Leads and false
// positives, most of them accounts of people never shown to be involved, live
// in the private checkout, and are merged back in here so the never-re-add
// rules above still see them.
// The research notes (each dork's results, and the `_*_notes` keys) go private
// with them: they name the people a search turned up.
const PUBLIC_STATUSES = new Set(["under-review", "confirmed"]);
const PUBLIC_DORK_FIELDS = new Set(["query", "targets"]);
const PRIVATE_FILE = "candidates.json";
const isNoteKey = (k) => k.startsWith("_") && k !== "_comment";

function readData() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const held = readPrivateJson(PRIVATE_FILE, { candidates: [], dork_notes: {}, notes: {} });
  data.candidates = [...(data.candidates || []), ...held.candidates];
  for (const [id, notes] of Object.entries(held.dork_notes || {})) {
    if (data.dorks[id]) Object.assign(data.dorks[id], notes);
  }
  return { ...data, ...(held.notes || {}) };
}

function writeData(data) {
  const shown = data.candidates.filter((c) => PUBLIC_STATUSES.has(c.status));
  const held = data.candidates.filter((c) => !PUBLIC_STATUSES.has(c.status));
  if (!hasPrivateData()) {
    console.error("The candidate queue needs _drafts/private/ for its lead and false-positive rows. Nothing written.");
    process.exit(1);
  }
  const publicData = {};
  const notes = {};
  for (const [k, v] of Object.entries(data)) (isNoteKey(k) ? notes : publicData)[k] = v;
  const dorkNotes = {};
  publicData.dorks = {};
  for (const [id, dork] of Object.entries(data.dorks || {})) {
    publicData.dorks[id] = {};
    for (const [field, value] of Object.entries(dork)) {
      if (PUBLIC_DORK_FIELDS.has(field)) publicData.dorks[id][field] = value;
      else (dorkNotes[id] = dorkNotes[id] || {})[field] = value;
    }
  }
  writeFileAtomic(privatePath(PRIVATE_FILE), JSON.stringify({ candidates: held, dork_notes: dorkNotes, notes }, null, 2) + "\n");
  writeFileAtomic(DATA_PATH, JSON.stringify({ ...publicData, candidates: shown }, null, 2) + "\n");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function slugFromUrl(url) {
  const m = /linkedin\.com\/(?:in|pub)\/([^/]+)\/?$/i.exec(url);
  return m ? safeDecode(m[1]).toLowerCase() : null;
}

/**
 * Every LinkedIn URL already accounted for elsewhere on the site as a real
 * indicator: scraped reports, hand-transcribed dossiers, third-party
 * registries and direct observations, all merged by iocIndex.js. Loaded
 * lazily and only when needed, since it reads several data files this
 * script's other subcommands (--list-dorks) have no reason to touch.
 */
function knownPersonaUrls() {
  const buildIndex = require("../src/_data/iocIndex.js");
  const index = buildIndex();
  const urls = new Set();
  for (const record of index.records) {
    if (record.ioc_type === "linkedin_profile") {
      const normalized = normalizeLinkedin(record.value) || record.value;
      urls.add(normalized.toLowerCase());
    }
  }
  return urls;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function listDorks(data) {
  console.log("=== Heuristics ===\n");
  for (const [id, h] of Object.entries(data.heuristics)) {
    console.log(`${id}${h.dork_detectable ? "" : "  (not dork-detectable -- requires opening the profile)"}`);
    console.log(`  ${h.label}`);
    console.log(`  ${h.description}\n`);
  }
  console.log("=== Dork queries ===\n");
  for (const [id, d] of Object.entries(data.dorks)) {
    console.log(`${id}  [targets: ${d.targets.join(", ")}]`);
    console.log(`  ${d.query}`);
    if (d.tested) console.log(`  last tested ${d.tested}: ${d.result_notes}`);
    console.log("");
  }
}

/**
 * The canonical form of a candidate's own URL.
 *
 * This queue began as LinkedIn profiles and the whole tool assumed it: a URL
 * that would not normalize as a linkedin.com/in/ address was refused, and
 * --check called anything else malformed. That stopped being true when the
 * pipu.cc resumes arrived. Several of those have a GitHub account and a
 * marketplace listing and no LinkedIn profile at all, and the row's own URL is
 * whichever page best identifies it.
 *
 * A LinkedIn address is still normalized, because there is one right way to
 * write one and duplicates turn on it. Any other https URL is taken as it
 * stands, with a trailing slash trimmed so two spellings of the same page
 * cannot both be stored.
 */
function normalizeCandidateUrl(url) {
  const linkedin = normalizeLinkedin(url);
  if (linkedin) return linkedin;
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s]+\.[^\s]+/.test(trimmed) ? trimmed : null;
}
/**
 * Validates and adds one candidate. Returns a one-line status string rather
 * than throwing, so --import can report per-row outcomes and keep going
 * rather than aborting a whole batch on the first duplicate.
 */
function addCandidate(data, { url, dork, indicators, note }) {
  const normalized = normalizeCandidateUrl(url);
  if (!normalized) {
    return `SKIP  ${url}  -- not an https URL, not added`;
  }

  const heuristicIds = (Array.isArray(indicators) ? indicators : String(indicators || "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const unknownHeuristics = heuristicIds.filter((id) => !data.heuristics[id]);
  if (unknownHeuristics.length) {
    return `SKIP  ${normalized}  -- unknown heuristic id(s): ${unknownHeuristics.join(", ")}`;
  }
  if (!heuristicIds.length) {
    return `SKIP  ${normalized}  -- no matched_indicators given, refusing to add an unexplained lead`;
  }
  if (dork && dork !== "manual" && !data.dorks[dork]) {
    return `SKIP  ${normalized}  -- unknown dork id: ${dork}`;
  }

  const existing = data.candidates.find((c) => c.url && c.url.toLowerCase() === normalized.toLowerCase());
  if (existing) {
    return `SKIP  ${normalized}  -- already in the queue at status "${existing.status}", not duplicated`;
  }

  const known = knownPersonaUrls();
  if (known.has(normalized.toLowerCase())) {
    return `SKIP  ${normalized}  -- already tracked as a confirmed indicator elsewhere on the site (persona dossier / scraped report); this queue is for unconfirmed leads only`;
  }

  data.candidates.push({
    slug: slugFromUrl(normalized) || normalized,
    url: normalized,
    status: "lead",
    matched_indicators: heuristicIds,
    found_by_dork: dork || "manual",
    first_seen: todayIso(),
    last_checked: null,
    note: note || "",
    corroboration: [],
  });
  return `ADD   ${normalized}  -- lead, matched: ${heuristicIds.join(", ")}`;
}

function checkData(data) {
  let problems = 0;
  const byStatus = {};
  const seen = new Set();
  for (const c of data.candidates) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (!VALID_STATUSES.includes(c.status)) {
      console.error(`PROBLEM  ${c.url}  -- unknown status "${c.status}"`);
      problems++;
    }
    // A row resting only on an address or a number has no page; it is keyed
    // by its slug instead.
    const key = c.url ? c.url.toLowerCase() : "slug:" + c.slug;
    if (c.url) {
      const normalized = normalizeCandidateUrl(c.url);
      if (!normalized || normalized.toLowerCase() !== c.url.toLowerCase()) {
        console.error(`PROBLEM  ${c.url}  -- not stored in normalized form (expected ${normalized})`);
        problems++;
      }
    }
    if (seen.has(key)) {
      console.error(`PROBLEM  ${c.url || c.slug}  -- duplicate entry`);
      problems++;
    }
    seen.add(key);
    for (const id of c.matched_indicators || []) {
      if (!data.heuristics[id]) {
        console.error(`PROBLEM  ${c.url}  -- matched_indicators references unknown heuristic "${id}"`);
        problems++;
      }
    }
    if (c.found_by_dork && c.found_by_dork !== "manual" && !data.dorks[c.found_by_dork]) {
      console.error(`PROBLEM  ${c.url}  -- found_by_dork references unknown dork "${c.found_by_dork}"`);
      problems++;
    }
    if (c.status === "false-positive" && !c.reason) {
      console.error(`PROBLEM  ${c.url}  -- status false-positive with no reason recorded`);
      problems++;
    }
    if (c.status === "false-positive" && c.reason && !data.fp_reasons[c.reason]) {
      console.error(`PROBLEM  ${c.url}  -- reason "${c.reason}" is not one of fp_reasons`);
      problems++;
    }
    if (c.status === "confirmed" && (!c.corroboration || c.corroboration.length === 0)) {
      console.error(`PROBLEM  ${c.url}  -- status confirmed with no corroboration[] entry`);
      problems++;
    }
  }
  console.log("Candidates by status:", byStatus);
  console.log(problems ? `${problems} problem(s) found.` : "No structural problems found.");
  return problems;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = readData();

  if (args["list-dorks"]) {
    listDorks(data);
    return;
  }

  if (args.check) {
    process.exitCode = checkData(data) ? 1 : 0;
    return;
  }

  if (args.add) {
    const result = addCandidate(data, {
      url: args.add,
      dork: args.dork,
      indicators: args.indicators,
      note: args.note,
    });
    console.log(result);
    if (result.startsWith("ADD")) writeData(data);
    else process.exitCode = 1;
    return;
  }

  if (args.import) {
    const rows = JSON.parse(fs.readFileSync(path.resolve(args.import), "utf8"));
    if (!Array.isArray(rows)) throw new Error("--import file must contain a JSON array");
    let added = 0;
    for (const row of rows) {
      const result = addCandidate(data, {
        url: row.url,
        dork: row.dork,
        indicators: row.indicators,
        note: row.note,
      });
      console.log(result);
      if (result.startsWith("ADD")) added++;
    }
    if (added) writeData(data);
    console.log(`${added} of ${rows.length} row(s) added.`);
    return;
  }

  console.log(
    "Usage:\n" +
      "  node scripts/scan-candidates.js --list-dorks\n" +
      "  node scripts/scan-candidates.js --add <url> --dork <id> --indicators <a,b,c> [--note \"...\"]\n" +
      "  node scripts/scan-candidates.js --import <file.json>\n" +
      "  node scripts/scan-candidates.js --check\n"
  );
}

try {
  main();
} catch (err) {
  console.error("scan-candidates failed:", err.message);
  process.exitCode = 1;
}
