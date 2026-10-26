#!/usr/bin/env node
/**
 * enrich-ips.js
 * ==============================================================
 * What kind of network each IP-address indicator sits on: a hosting
 * provider's range, a known proxy or VPN, a mobile carrier, or an ordinary
 * fixed line. The distinction is what makes an address readable. A login from
 * a Comcast subscriber line in the city a CV claims is one thing; the same
 * login from a data-centre range in another country, or from an exit Spur
 * attributes to Astrill VPN, is another.
 *
 * Run manually, from the repository root, after adding IP indicators:
 *   node scripts/enrich-ips.js            # addresses with no entry yet
 *   node scripts/enrich-ips.js --refresh  # every address again
 *
 * Sources, in the order they are applied:
 *   1. Spur's Astrill VPN list, the 'spur-astrill-vpn-ips' dataset in
 *      src/_data/iocs/itworker-datasets.json (see sync-spur-astrill-ips.js).
 *      Membership sets the provider name; nothing else names a VPN service.
 *   2. ip-api.com's batch endpoint, which returns the announcing network and
 *      three flags -- hosting, proxy, mobile -- from its own classification.
 *      Free for non-commercial use over plain HTTP, 100 addresses a request,
 *      15 requests a minute; the script paces itself off the rate headers.
 *
 * Output: scripts/data/ip-lookups.json, keyed by address. Read at build time
 * by src/_data/iocIndex.js, which attaches a `network_status` block to each
 * IP record; partials/ioc-detail.njk renders it, and the search rows carry
 * the kind as a chip. An address with no entry renders with no network block
 * at all: "not looked up" and "unknown" are different claims.
 *
 * `kind` is one of:
 *   vpn         on Spur's Astrill list (provider says which service)
 *   proxy       ip-api flags it as a proxy or VPN, service unknown
 *   datacenter  a hosting or cloud provider's range
 *   mobile      a mobile carrier's range
 *   fixed-line  none of the above: an ISP's subscriber range
 * A range can be several of these at once -- most VPN exits are rented from
 * hosting providers -- so the flags are kept beside the kind.
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

const OUT_PATH = path.join(__dirname, "data", "ip-lookups.json");
const DATASETS_PATH = path.join(__dirname, "..", "src", "_data", "iocs", "itworker-datasets.json");
const API_URL = "http://ip-api.com/batch?fields=status,message,query,country,countryCode,isp,org,as,asname,mobile,proxy,hosting";
const BATCH = 100;

const refresh = process.argv.includes("--refresh");
const today = new Date().toISOString().slice(0, 10);

function loadLookups() {
  if (!fs.existsSync(OUT_PATH)) {
    return {
      _comment:
        "What kind of network each IP-address indicator sits on. See docs/ip-network-types.md for how these were obtained and what each field is allowed to claim. Read at build time by src/_data/iocIndex.js; nothing here is synthesized, and an address with no entry renders with no network block at all.",
      checked: today,
      addresses: {},
    };
  }
  return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
}

function astrillSet() {
  if (!fs.existsSync(DATASETS_PATH)) return new Set();
  const datasets = JSON.parse(fs.readFileSync(DATASETS_PATH, "utf8"));
  const spur = datasets.find((d) => d.dataset_id === "spur-astrill-vpn-ips");
  return new Set(spur ? spur.entries : []);
}

function classify(row, astrill) {
  if (astrill.has(row.query)) return { kind: "vpn", provider: "Astrill VPN" };
  if (row.proxy) return { kind: "proxy", provider: null };
  if (row.hosting) return { kind: "datacenter", provider: null };
  if (row.mobile) return { kind: "mobile", provider: null };
  return { kind: "fixed-line", provider: null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookupBatch(ips) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "ChollimaHunterEnrich/1.0" },
      body: JSON.stringify(ips),
      signal: AbortSignal.timeout(30000),
    });
    const remaining = Number(res.headers.get("X-Rl"));
    const ttl = Number(res.headers.get("X-Ttl"));
    if (res.status === 429) {
      await sleep((Number.isFinite(ttl) ? ttl + 1 : 60) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`ip-api returned ${res.status}`);
    const rows = await res.json();
    // Pace off the window the service reports rather than a fixed sleep.
    if (remaining === 0 && Number.isFinite(ttl)) await sleep((ttl + 1) * 1000);
    return rows;
  }
  throw new Error("ip-api: rate limit retries exhausted");
}

async function main() {
  const index = require("../src/_data/iocIndex.js")();
  const ips = Array.from(new Set(index.records.filter((r) => r.ioc_type === "ip_address").map((r) => r.value)));
  const lookups = loadLookups();
  const astrill = astrillSet();

  // Astrill membership is recomputed every run even for addresses already on
  // file, so a later sync of Spur's list is reflected without a refresh.
  for (const ip of ips) {
    const entry = lookups.addresses[ip];
    if (entry && astrill.has(ip) && entry.kind !== "vpn") {
      Object.assign(entry, { kind: "vpn", provider: "Astrill VPN" });
    }
  }

  const pending = ips.filter((ip) => refresh || !lookups.addresses[ip]);
  console.log(`${ips.length} IP indicators in the index, ${pending.length} to look up.`);

  let done = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    let rows;
    try {
      rows = await lookupBatch(chunk);
    } catch (err) {
      console.error(`batch at ${i} failed: ${err.message}`);
      failed += chunk.length;
      continue;
    }
    for (const row of rows) {
      if (row.status !== "success") {
        // Private, reserved and bogon ranges come back as "fail"; recorded so
        // the address is not asked about again, with the reason kept.
        lookups.addresses[row.query] = { kind: "unresolved", provider: null, note: row.message || "no answer", checked: today, looked_up_at: "ip-api.com" };
        continue;
      }
      const { kind, provider } = classify(row, astrill);
      lookups.addresses[row.query] = {
        kind,
        provider,
        country: row.countryCode || null,
        country_name: row.country || null,
        isp: row.isp || null,
        org: row.org || null,
        asn: row.as || null,
        as_name: row.asname || null,
        hosting: !!row.hosting,
        proxy: !!row.proxy,
        mobile: !!row.mobile,
        checked: today,
        looked_up_at: "ip-api.com",
      };
    }
    done += chunk.length;
    if (done % 500 === 0 || done === pending.length) {
      writeFileAtomic(OUT_PATH, JSON.stringify(lookups, null, 2) + "\n");
      console.log(`${done} of ${pending.length} looked up`);
    }
  }

  lookups.checked = today;
  // Stable order so the diff on a rerun is the changed entries alone.
  const key = (ip) => ip.split(".").map((n) => n.padStart(3, "0")).join(".");
  lookups.addresses = Object.fromEntries(Object.entries(lookups.addresses).sort(([a], [b]) => key(a).localeCompare(key(b))));
  writeFileAtomic(OUT_PATH, JSON.stringify(lookups, null, 2) + "\n");

  const counts = {};
  for (const ip of ips) {
    const k = (lookups.addresses[ip] || {}).kind || "not looked up";
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log("By kind:", JSON.stringify(counts));
  if (failed) console.log(`${failed} addresses failed and will be retried next run.`);
}

main().catch((err) => {
  console.error("Enrichment failed:", err.message);
  process.exitCode = 1;
});
