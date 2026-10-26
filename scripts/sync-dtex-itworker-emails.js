#!/usr/bin/env node
/**
 * sync-dtex-itworker-emails.js
 * ==============================================================
 * Fetches DTEX's public i3 Threat Advisory page, decodes its
 * Cloudflare-obfuscated "Email IOCs" appendix, and updates the
 * 'dtex-i3-email-iocs' dataset object inside
 * src/_data/iocs/itworker-datasets.json in place.
 *
 * Run manually:
 *   node scripts/sync-dtex-itworker-emails.js
 *
 * Run on a schedule: see .github/workflows/sync-itworker-datasets.yml,
 * which runs this weekly and opens a PULL REQUEST (never a direct commit
 * to main) if entries changed — new/removed identifiers go through the
 * same human-review-before-publish gate as every other content change on
 * this site, since these are unverified leads about real email addresses,
 * not confirmed findings.
 *
 * Exits with code 0 always; prints "CHANGED=true"/"CHANGED=false" as the
 * last line of stdout so the GitHub Actions workflow can branch on it.
 *
 * Decoding note: DTEX's page renders each email through Cloudflare's
 * standard "email address obfuscation" feature (a `data-cfemail="<hex>"`
 * attribute that the visitor's own browser decodes via Cloudflare's public
 * JS on every normal page view — this is an anti-scraper measure, not an
 * access control; nothing here bypasses a login, paywall, or robots
 * restriction). The decode is the well-documented, widely-published
 * single-byte XOR scheme Cloudflare itself uses.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");

const { decodeCfEmail, normalizeEmail } = require("./lib/ioc-normalize.js");

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

const SOURCE_URL = "https://www.dtex.ai/resources/i3-threat-advisory-inside-the-dprk/";
const DATA_PATH = path.join(__dirname, "..", "src", "_data", "iocs", "itworker-datasets.json");
const DATASET_ID = "dtex-i3-email-iocs";

const MAX_PAGE_BYTES = 50 * 1024 * 1024;

async function fetchAndDecode() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChollimaHunterSync/1.0)" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
    throw new Error(`response exceeds ${MAX_PAGE_BYTES} bytes (content-length ${declaredLength})`);
  }
  const html = await res.text();
  if (html.length > MAX_PAGE_BYTES) {
    throw new Error(`response exceeds ${MAX_PAGE_BYTES} bytes`);
  }

  const hexMatches = [...html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)].map((m) => m[1]);
  const decoded = hexMatches.map(decodeCfEmail);

  // Each address is stored as the mailbox it reaches, the same way the rest
  // of the index stores one (see canonicalMailbox in ioc-normalize.js). DTEX
  // prints the dotted spellings; diffing those against the stored mailboxes
  // reported every Gmail entry as both added and removed, week after week.
  const valid = [];
  const malformed = [];
  for (const email of decoded) {
    const mailbox = normalizeEmail(email);
    if (mailbox) valid.push(mailbox);
    else malformed.push(email);
  }

  const uniqueValid = Array.from(new Set(valid)).sort();
  return { uniqueValid, malformedCount: malformed.length, totalDecoded: decoded.length };
}

function loadDatasets() {
  if (!fs.existsSync(DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

function diffSummary(oldEntries, newEntries) {
  const oldSet = new Set(oldEntries);
  const newSet = new Set(newEntries);
  const added = newEntries.filter((e) => !oldSet.has(e));
  const removed = oldEntries.filter((e) => !newSet.has(e));
  return { added, removed };
}

async function main() {
  const { uniqueValid, malformedCount } = await fetchAndDecode();
  const datasets = loadDatasets();
  const idx = datasets.findIndex((d) => d.dataset_id === DATASET_ID);
  const today = new Date().toISOString().slice(0, 10);

  const existingEntries = idx >= 0 ? datasets[idx].entries : [];
  // A page that moved or stopped serving its Cloudflare-encoded cells decodes
  // to nothing or to a fragment. Refuse rather than open a PR that deletes
  // most of the dataset.
  if (uniqueValid.length === 0 || uniqueValid.length < existingEntries.length / 2) {
    throw new Error(
      `only ${uniqueValid.length} valid address(es) parsed against ${existingEntries.length} held; refusing to overwrite the dataset`
    );
  }
  const { added, removed } = diffSummary(existingEntries, uniqueValid);
  const changed = added.length > 0 || removed.length > 0 || idx < 0;

  const datasetObject = {
    dataset_id: DATASET_ID,
    title: "i3 Threat Advisory: Identifying North Korean IT Workers — Email IOCs Appendix",
    ioc_type: "email_address",
    // The advisory is specifically about IT workers (see its own title);
    // it is not Contagious Interview reporting. Tagging it with the combined
    // cluster label made every address here claim both.
    campaign: ["IT Worker Fraud"],
    confidence_level: "low",
    description:
      "A bulk list of email addresses DTEX's i3 threat intelligence team has observed associated with DPRK IT-worker operations, published as a public appendix so defenders can cross-check their own HR/recruitment records. Compiled by DTEX from third-party reporting connected to observed IT-worker operations.",
    disclaimer:
      "Per DTEX's own advisory text: these IOCs are NOT indicative of a confirmed North-Korea-attributed hack — they may have associations with IT-worker operations and require further investigation if observed in your environment. Any connection to actual persons may be deliberate (an operator using a real person's identity) or incidental, and the actual owner of an email account listed here may be unaware their address is associated with this IOC list. Do not treat presence on this list as proof of wrongdoing by the account holder.",
    source: {
      title: "i3 Threat Advisory: Identifying North Korean IT Workers: Key Threat Indicators",
      url: SOURCE_URL,
      publisher: "DTEX Systems (i3)",
      date: "2025-05-14",
      type: "threat_intel_report",
    },
    sync: {
      method: "scheduled",
      last_synced: today,
      tool_path: "scripts/sync-dtex-itworker-emails.js",
    },
    entry_count: uniqueValid.length,
    excluded_count: malformedCount,
    excluded_notes:
      malformedCount > 0
        ? `${malformedCount} decoded value(s) from the source did not match a valid email format (e.g. a stray numeric suffix like '-13' appended in the source's own table cell) and were excluded rather than guessed at.`
        : undefined,
    entries: uniqueValid,
  };

  if (idx >= 0) {
    datasets[idx] = datasetObject;
  } else {
    datasets.push(datasetObject);
  }

  writeFileAtomic(DATA_PATH, JSON.stringify(datasets, null, 2) + "\n");

  console.log(`Fetched ${uniqueValid.length} valid unique email(s), ${malformedCount} malformed excluded.`);
  console.log(`Added: ${added.length}, Removed: ${removed.length}`);
  if (added.length) console.log("New entries:\n" + added.map((e) => `  + ${e}`).join("\n"));
  if (removed.length) console.log("Removed entries:\n" + removed.map((e) => `  - ${e}`).join("\n"));
  console.log(`CHANGED=${changed}`);
}

main().catch((err) => {
  console.error("Sync failed:", err.message);
  console.log("CHANGED=false");
  process.exitCode = 1;
});
