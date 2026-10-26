#!/usr/bin/env node
/**
 * sync-spur-astrill-ips.js
 * ==============================================================
 * Fetches the Astrill VPN exit-address list Spur publishes alongside its
 * post "Astrill VPN and DPRK Remote Worker Fraud", and updates the
 * 'spur-astrill-vpn-ips' dataset object inside
 * src/_data/iocs/itworker-datasets.json in place.
 *
 * Run manually:
 *   node scripts/sync-spur-astrill-ips.js
 *
 * Run on a schedule: see .github/workflows/sync-itworker-datasets.yml,
 * which runs this weekly next to the DTEX sync and opens a PULL REQUEST
 * (never a direct commit to main) if entries changed.
 *
 * The list is a plain text file, one IPv4 address per line, served from a
 * public bucket Spur links from the post. Every address on it is an exit
 * that any Astrill customer may be behind, so the dataset's disclaimer says
 * what a match means: a connection through a service DPRK IT workers are
 * documented to favour, not a DPRK connection.
 *
 * Exits with code 0 always; prints "CHANGED=true"/"CHANGED=false" as the
 * last line of stdout so the workflow can branch on it.
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

const SOURCE_URL = "https://storage.googleapis.com/spur-astrill-vpn/ips.txt";
const POST_URL = "https://spur.us/blog/astrill-vpn-and-dprk-remote-worker-fraud";
const DATA_PATH = path.join(__dirname, "..", "src", "_data", "iocs", "itworker-datasets.json");
const DATASET_ID = "spur-astrill-vpn-ips";

const MAX_BYTES = 5 * 1024 * 1024;

async function fetchList() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChollimaHunterSync/1.0)" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    throw new Error(`response exceeds ${MAX_BYTES} bytes (content-length ${declaredLength})`);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`response exceeds ${MAX_BYTES} bytes`);

  const valid = [];
  let malformed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // The same normaliser the index applies to every address, so an entry the
    // site would refuse -- a network address ending in .0, a reserved range --
    // is counted here rather than filed and then dropped at build time.
    const value = normalizeIpv4(line);
    if (value) valid.push(value);
    else malformed++;
  }
  // Numeric order rather than string order, so 9.x sorts before 10.x and a
  // diff against the previous sync reads as a list of addresses.
  const key = (ip) => ip.split(".").map((n) => n.padStart(3, "0")).join(".");
  const unique = Array.from(new Set(valid)).sort((a, b) => key(a).localeCompare(key(b)));
  return { unique, malformed };
}

function loadDatasets() {
  if (!fs.existsSync(DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

function diffSummary(oldEntries, newEntries) {
  const oldSet = new Set(oldEntries);
  const newSet = new Set(newEntries);
  return {
    added: newEntries.filter((e) => !oldSet.has(e)),
    removed: oldEntries.filter((e) => !newSet.has(e)),
  };
}

async function main() {
  const { unique, malformed } = await fetchList();
  if (unique.length < 100) {
    // A near-empty list means the bucket moved or the file was replaced, not
    // that Astrill shrank to a handful of exits. Refuse rather than open a PR
    // that removes two thousand entries.
    throw new Error(`only ${unique.length} addresses parsed; refusing to overwrite the dataset`);
  }
  const datasets = loadDatasets();
  const idx = datasets.findIndex((d) => d.dataset_id === DATASET_ID);
  const today = new Date().toISOString().slice(0, 10);

  const existingEntries = idx >= 0 ? datasets[idx].entries : [];
  const { added, removed } = diffSummary(existingEntries, unique);
  const changed = added.length > 0 || removed.length > 0 || idx < 0;

  const datasetObject = {
    dataset_id: DATASET_ID,
    title: "Astrill VPN exit addresses published by Spur",
    ioc_type: "ip_address",
    campaign: ["IT Worker Fraud"],
    confidence_level: "low",
    // Rendered on the indicator page and carried into the network block, so
    // an address from this list is labelled as an Astrill exit wherever it
    // appears rather than as a bare IP beside a campaign chip.
    network: { kind: "vpn", provider: "Astrill VPN" },
    description:
      "IPv4 addresses Spur attributes to the Astrill VPN service, released free in December 2024 alongside its post on the service's use in DPRK remote-worker fraud. Spur, whose business is attributing anonymising infrastructure, published about 2,400 addresses it recorded as active on 19 December 2024 and said its customers were continuing to report fraudulent remote-worker applications arriving from them.",
    disclaimer:
      "These are the exit addresses of a commercial VPN service with customers everywhere. An address on this list says that a connection came through Astrill, which DPRK IT workers are documented to favour; it does not say who was behind the connection, and the great majority of traffic through these exits is ordinary customers. Treat a match as a reason to look at the account behind it, not as evidence about the person. The list is a snapshot of the addresses active on 19 December 2024; VPN exits are reassigned over time, so an address here may since have been returned to its hosting provider and given to someone else. The list is Spur's and is carried here as published.",
    source: {
      title: "Astrill VPN and DPRK Remote Worker Fraud",
      url: POST_URL,
      list_url: SOURCE_URL,
      publisher: "Spur",
      date: "2024-12-19",
      type: "threat_intel_report",
    },
    sync: {
      method: "scheduled",
      last_synced: today,
      tool_path: "scripts/sync-spur-astrill-ips.js",
    },
    entry_count: unique.length,
    excluded_count: malformed,
    excluded_notes:
      malformed > 0
        ? `${malformed} line(s) in the source were not a single routable IPv4 host address (a .0 network address, a reserved range, or not an address at all) and were excluded rather than guessed at.`
        : undefined,
    entries: unique,
  };

  if (idx >= 0) datasets[idx] = datasetObject;
  else datasets.push(datasetObject);

  writeFileAtomic(DATA_PATH, JSON.stringify(datasets, null, 2) + "\n");

  console.log(`Fetched ${unique.length} unique address(es), ${malformed} malformed excluded.`);
  console.log(`Added: ${added.length}, Removed: ${removed.length}`);
  if (added.length && added.length <= 50) console.log("New entries:\n" + added.map((e) => `  + ${e}`).join("\n"));
  if (removed.length && removed.length <= 50) console.log("Removed entries:\n" + removed.map((e) => `  - ${e}`).join("\n"));
  console.log(`CHANGED=${changed}`);
}

main().catch((err) => {
  console.error("Sync failed:", err.message);
  console.log("CHANGED=false");
  process.exitCode = 1;
});
