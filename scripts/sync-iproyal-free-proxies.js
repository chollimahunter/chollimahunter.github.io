#!/usr/bin/env node
/**
 * sync-iproyal-free-proxies.js
 * ==============================================================
 * Fetches the free proxy list IPRoyal publishes at
 * https://iproyal.com/free-proxy-list/ and updates the
 * 'iproyal-free-proxy-ips' dataset object inside
 * src/_data/iocs/itworker-datasets.json in place.
 *
 * Run manually:
 *   node scripts/sync-iproyal-free-proxies.js
 *   node scripts/sync-iproyal-free-proxies.js --from saved-records.json
 *
 * Run on a schedule: see .github/workflows/sync-itworker-datasets.yml,
 * which runs this weekly next to the DTEX and Spur syncs and opens a PULL
 * REQUEST (never a direct commit to main) if entries changed.
 *
 * Why it is carried: 2026 reporting on DPRK remote-worker cases names
 * IPRoyal beside Astrill as a service the workers connect through. What the
 * page lists is IPRoyal's directory of free, public proxy servers, which is
 * not the same thing as the company's paid residential pool; the dataset's
 * disclaimer says so, and a match means "a connection through a public
 * proxy on IPRoyal's list", nothing about who was behind it.
 *
 * The page fills its table in the browser by calling the site's
 * getFreeProxyList action ten records at a time, so the script makes the same
 * calls: it confirms the table component the page loads still uses that
 * action, then pages through every record. It refuses to
 * write when it parses fewer than
 * MIN_ADDRESSES, or fewer than half the entries already stored, so a layout
 * change produces a failed run and not a pull request that empties the list.
 *
 * Exits 0 on success and 1 on failure; prints "CHANGED=true"/"CHANGED=false"
 * as the last line of stdout so the workflow can branch on it.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { normalizeIpv4 } = require("./lib/ioc-normalize.js");

/** Prints the header comment's opening paragraph and exits 0, for --help/-h. */
function printHelp() {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  if (!m) return;
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  let i = lines.findIndex((l) => /^=+$/.test(l.trim())) + 1;
  while (lines[i] !== undefined && !lines[i].trim()) i++;
  const para = [];
  while (lines[i] !== undefined && lines[i].trim()) para.push(lines[i++]);
  console.log(para.join(" ").replace(/\s+/g, " ").trim());
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const PAGE_URL = "https://iproyal.com/free-proxy-list/";
const DATA_PATH = path.join(__dirname, "..", "src", "_data", "iocs", "itworker-datasets.json");
const DATASET_ID = "iproyal-free-proxy-ips";
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_ADDRESSES = 20;
const ACTION_NAME = "getFreeProxyList";
const ACTION_URL = `https://iproyal.com/_actions/${ACTION_NAME}/`;
// The action serves ten records a page (about 620 pages in November 2026).
const MAX_PAGES = 2000;
const PAGE_DELAY_MS = 100;
const USER_AGENT = "Mozilla/5.0 (compatible; ChollimaHunterSync/1.0)";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`${url} exceeds ${MAX_BYTES} bytes`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${url} exceeds ${MAX_BYTES} bytes`);
  return text;
}

/**
 * The page renders its table in the browser through a script component that
 * calls the site's getFreeProxyList action. Confirming the live component
 * still names the action makes a redesign fail the run instead of reading an
 * endpoint the page has stopped using.
 */
async function checkComponent() {
  const html = await fetchText(PAGE_URL);
  const component = html.match(/component-url="([^"]*FreeProxyListTable[^"]*\.js)"/);
  if (!component) throw new Error("the page no longer loads a FreeProxyListTable component");
  const script = await fetchText(new URL(component[1], PAGE_URL).href);
  if (!script.includes(`${ACTION_NAME}(`)) throw new Error(`the table component no longer calls ${ACTION_NAME}`);
}

/**
 * Rebuilds a value from devalue's flat encoding, the format the action
 * answers in: an array whose first element is the root and whose objects and
 * arrays hold indices into the same array. Only plain objects, arrays and
 * primitives are expected; any typed form (Date, Map, ...) fails the run.
 */
function unflatten(flat) {
  if (!Array.isArray(flat) || flat.length === 0) throw new Error("the action answered with an empty or non-array body");
  const memo = new Map();
  const hydrate = (i) => {
    if (i === -1) return undefined;
    if (!Number.isInteger(i) || i < 0 || i >= flat.length) throw new Error(`devalue index ${i} out of range`);
    if (memo.has(i)) return memo.get(i);
    const v = flat[i];
    let out;
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") throw new Error(`unsupported devalue type ${v[0]}`);
      out = [];
      memo.set(i, out);
      for (const j of v) out.push(hydrate(j));
    } else if (v && typeof v === "object") {
      out = {};
      memo.set(i, out);
      for (const [k, j] of Object.entries(v)) out[k] = hydrate(j);
    } else {
      out = v;
      memo.set(i, out);
    }
    return out;
  };
  return hydrate(0);
}

async function fetchPage(page) {
  const res = await fetch(ACTION_URL, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ page }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`action page ${page} failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`action page ${page} exceeds ${MAX_BYTES} bytes`);
  const body = unflatten(JSON.parse(text));
  if (!Array.isArray(body?.records)) throw new Error(`action page ${page} has no records array`);
  return body;
}

/** Every record the list holds, one action page at a time. */
async function fetchRecords() {
  await checkComponent();
  const records = [];
  let pageCount = 1;
  for (let page = 1; page <= pageCount; page++) {
    const body = await fetchPage(page);
    records.push(...body.records);
    if (page === 1) {
      pageCount = Number(body.pagination?.pageCount) || 1;
      if (pageCount > MAX_PAGES) throw new Error(`the list reports ${pageCount} pages, more than the ${MAX_PAGES} this script will read`);
    }
    if (page < pageCount) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }
  return records;
}

function extractAddresses(records) {
  const valid = [];
  let malformed = 0;
  const seen = new Set();
  for (const r of records) {
    const port = Number(r.port);
    const value = Number.isInteger(port) && port >= 1 && port <= 65535 ? normalizeIpv4(String(r.ip ?? "")) : null;
    if (!value) { malformed++; continue; }
    if (!seen.has(value)) { seen.add(value); valid.push(value); }
  }
  return { valid, malformed };
}

async function fetchList() {
  const fromIdx = process.argv.indexOf("--from");
  const records = fromIdx >= 0 ? JSON.parse(fs.readFileSync(process.argv[fromIdx + 1], "utf8")) : await fetchRecords();
  const { valid, malformed } = extractAddresses(Array.isArray(records) ? records : records.records ?? records.data ?? []);
  if (valid.length < MIN_ADDRESSES) {
    throw new Error(`only ${valid.length} addresses parsed; refusing to overwrite the dataset`);
  }
  const key = (ip) => ip.split(".").map((n) => n.padStart(3, "0")).join(".");
  return { unique: valid.sort((a, b) => key(a).localeCompare(key(b))), malformed };
}

function loadDatasets() {
  return fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) : [];
}

async function main() {
  const { unique, malformed } = await fetchList();
  const datasets = loadDatasets();
  const idx = datasets.findIndex((d) => d.dataset_id === DATASET_ID);
  const existing = idx >= 0 ? datasets[idx].entries : [];
  if (existing.length && unique.length < existing.length / 2) {
    throw new Error(`parsed ${unique.length} addresses against ${existing.length} stored; refusing to shrink the dataset by half`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const oldSet = new Set(existing);
  const newSet = new Set(unique);
  const added = unique.filter((e) => !oldSet.has(e));
  const removed = existing.filter((e) => !newSet.has(e));
  const changed = idx < 0 || added.length > 0 || removed.length > 0;

  const datasetObject = {
    dataset_id: DATASET_ID,
    title: "Free proxy servers listed by IPRoyal",
    ioc_type: "ip_address",
    campaign: ["IT Worker Fraud"],
    confidence_level: "low",
    // Labels every address as a proxy wherever it appears, the way the Spur
    // list labels its addresses as Astrill exits.
    network: { kind: "proxy", provider: "IPRoyal free proxy list" },
    description:
      "IPv4 addresses of the free, public proxy servers IPRoyal lists on its site, as read on the sync date. Reporting on DPRK remote-worker cases in 2026 names IPRoyal beside Astrill VPN as a service the workers route through; carrying the public list lets a defender label a connection that came through one of these proxies.",
    disclaimer:
      "This is IPRoyal's directory of free public proxies, not the company's paid residential network, and the servers on it belong to third parties and are used by anyone who finds the list. A match says that a connection came through a public proxy that IPRoyal listed on the day the list was read; it says nothing about who was behind it. Free proxies rotate within days, so the list is a snapshot that the weekly sync replaces, and an address here may since have gone back to ordinary use. Treat a match as a reason to look at the account behind it, never as evidence about the person.",
    source: {
      title: "Free Proxy List",
      url: PAGE_URL,
      list_url: PAGE_URL,
      publisher: "IPRoyal",
      date: today,
      type: "vendor_dataset",
    },
    sync: { method: "scheduled", last_synced: today, tool_path: "scripts/sync-iproyal-free-proxies.js" },
    entry_count: unique.length,
    excluded_count: malformed,
    excluded_notes:
      malformed > 0
        ? `${malformed} record(s) on the list were excluded because the index does not carry the address: CDN edge addresses (most of them Cloudflare's, shared by millions of sites), network or reserved addresses, public resolvers, or a value that is not a dotted IPv4 address with a valid port.`
        : undefined,
    entries: unique,
  };

  if (idx >= 0) datasets[idx] = datasetObject;
  else datasets.push(datasetObject);
  writeFileAtomic(DATA_PATH, JSON.stringify(datasets, null, 2) + "\n");

  console.log(`Fetched ${unique.length} unique address(es), ${malformed} malformed excluded.`);
  console.log(`Added: ${added.length}, Removed: ${removed.length}`);
  console.log(`CHANGED=${changed}`);
}

main().catch((err) => {
  console.error("Sync failed:", err.message);
  console.log("CHANGED=false");
  process.exitCode = 1;
});
