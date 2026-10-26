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
 * The page fills its table in the browser from IPRoyal's CMS
 * (api/free-proxy-records), so the script reads the same records: it finds
 * the table component the page loads, takes the CMS address and the
 * read-only token from it, and pages through every record. It refuses to
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
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
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
 * The page renders its table in the browser from IPRoyal's CMS, through a
 * script component that carries the CMS address and a read-only access token
 * every visitor's browser receives. Both are read from the live script on each
 * run rather than stored here, so a rotated token or a moved component is
 * picked up without a code change. The token is never printed.
 */
async function cmsAccess() {
  const html = await fetchText(PAGE_URL);
  const component = html.match(/component-url="([^"]*FreeProxyListTable[^"]*\.js)"/);
  if (!component) throw new Error("the page no longer loads a FreeProxyListTable component");
  const script = await fetchText(new URL(component[1], PAGE_URL).href);
  const base = script.match(/baseURL:\s*[`"'](https:\/\/[^`"']+)[`"']/);
  const token = script.match(/Bearer ([0-9a-f]{32,})/);
  if (!base || !token) throw new Error("the table component no longer names a CMS address and access token");
  if (!script.includes("api/free-proxy-records")) throw new Error("the table component no longer reads api/free-proxy-records");
  return { base: base[1], token: token[1] };
}

/** Every record the CMS holds, a page of PAGE_SIZE at a time. */
async function fetchRecords() {
  const { base, token } = await cmsAccess();
  const records = [];
  for (let page = 1, pageCount = 1; page <= pageCount && page <= MAX_PAGES; page++) {
    const url = `${base}/api/free-proxy-records?fields[0]=ip&fields[1]=port&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`CMS page ${page} failed: ${res.status} ${res.statusText}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) throw new Error(`CMS page ${page} has no data array`);
    records.push(...body.data);
    pageCount = Number(body.meta?.pagination?.pageCount) || 1;
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
  const { valid, malformed } = extractAddresses(Array.isArray(records) ? records : records.data ?? []);
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
