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
 *   node scripts/sync-iproyal-free-proxies.js --from saved-page.html
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
 * The page is HTML rather than a plain list, and its markup is not under
 * this repository's control, so the parser is deliberately loose: it takes
 * every IPv4 address that is followed, within a few characters, by a port
 * number, whether the pair sits in table cells or in an embedded JSON state
 * object, and also follows any .txt/.csv/.json download link the page offers
 * on the same host. It refuses to write when it parses fewer than
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
 * Every IPv4 address followed, with no other digit in between, by a 1-5 digit
 * port within 60 characters. The gap allows a closing and opening table cell,
 * a colon, or JSON punctuation such as `","port":`. The port must not be the
 * first octet of the next address, so an address with no port of its own (the
 * visitor's IP in a banner, say) pairs with nothing and is dropped.
 */
const PAIR = /\b(\d{1,3}(?:\.\d{1,3}){3})\b[^0-9]{1,60}?(\d{1,5})\b(?!\.\d)/g;

function extractAddresses(text) {
  const valid = [];
  let malformed = 0;
  const seen = new Set();
  for (const m of text.matchAll(PAIR)) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535) continue;
    const value = normalizeIpv4(m[1]);
    if (!value) { malformed++; continue; }
    if (!seen.has(value)) { seen.add(value); valid.push(value); }
  }
  return { valid, malformed };
}

/** A .txt/.csv/.json link on the same host, if the page offers a download. */
function downloadLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="([^"]+\.(?:txt|csv|json)(?:\?[^"]*)?)"/gi)) {
    try {
      const u = new URL(m[1], PAGE_URL);
      if (u.hostname === new URL(PAGE_URL).hostname) out.add(u.href);
    } catch {}
  }
  return [...out].slice(0, 3);
}

async function fetchList() {
  const fromIdx = process.argv.indexOf("--from");
  const html = fromIdx >= 0 ? fs.readFileSync(process.argv[fromIdx + 1], "utf8") : await fetchText(PAGE_URL);
  let { valid, malformed } = extractAddresses(html);
  if (fromIdx < 0) {
    for (const link of downloadLinks(html)) {
      try {
        const more = extractAddresses(await fetchText(link));
        for (const v of more.valid) if (!valid.includes(v)) valid.push(v);
        malformed += more.malformed;
        console.log(`Followed download link ${link}: ${more.valid.length} address(es).`);
      } catch (err) {
        console.log(`Download link ${link} skipped: ${err.message}`);
      }
    }
  }
  if (valid.length < MIN_ADDRESSES) {
    // Print the shape of what came back, so a layout change is diagnosable
    // from the workflow log without re-fetching the page by hand.
    console.error(`page yielded ${valid.length} address(es); first 400 characters of the body:\n${html.slice(0, 400)}`);
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
        ? `${malformed} address(es) on the page were not a single routable IPv4 host address and were excluded rather than guessed at.`
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
