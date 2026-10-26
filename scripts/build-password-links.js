#!/usr/bin/env node
/**
 * build-password-links.js
 * ==============================================================
 * Turns the email/password sample table in the Raven File write-up into the
 * password each operator address was reported with, plus the reuse graph
 * between them.
 *
 *   node scripts/build-password-links.js
 *
 * WHAT AND WHY
 * ------------
 * Operator passwords are tracked. Password reuse is a linkage pivot: two
 * accounts that logged in with the same string are very likely one operator.
 * The string itself is worth having too: operators reuse habits across
 * accounts and campaigns, and a defender can search logs and dumps for it.
 *
 * So this writes each address's reported password under `passwords`, and
 * groups the addresses that share one under `clusters`, keyed by a short
 * fingerprint (sha256, first 12 hex) that serves as a stable cluster id.
 *
 * INPUT
 * -----
 * The staged run for the Raven File article, under _drafts/iocs/. That file is
 * gitignored and transient; the committed artifact is the map this writes.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const crypto = require("crypto");
// Keyed by the canonical mailbox, the form every email record is stored and
// identified under, so a dotted Gmail address in the table finds its record.
const { normalizeEmail } = require("./lib/ioc-normalize.js");

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
const STAGING = path.join(ROOT, "_drafts", "iocs");
const OUT = path.join(ROOT, "src", "_data", "iocs", "password-links.json");
const SOURCE_MATCH = /theravenfile-com-unmasking/;

function fingerprint(password) {
  return crypto.createHash("sha256").update(password.trim().toLowerCase()).digest("hex").slice(0, 12);
}

function pairsFrom(text) {
  const start = text.indexOf("EMAIL ADDRESSES PASSWORD");
  const end = text.indexOf("DPRK PASSWORD ANALYSIS");
  if (start < 0 || end < 0) return [];
  const block = text.slice(start + "EMAIL ADDRESSES PASSWORD".length, end);
  const re =
    /([a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,})\s+(\S.*?)(?=\s+[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}|$)/gis;
  const pairs = [];
  let m;
  while ((m = re.exec(block))) {
    const printed = m[1].trim().toLowerCase();
    pairs.push([normalizeEmail(printed) || printed, m[2].trim()]);
  }
  return pairs;
}

function main() {
  const file = fs.existsSync(STAGING)
    ? fs.readdirSync(STAGING).find((f) => SOURCE_MATCH.test(f) && f.endsWith(".json"))
    : null;
  if (!file) {
    console.error("No Raven File run staged; re-scrape the source before rebuilding.");
    process.exitCode = 1;
    return;
  }

  const run = JSON.parse(fs.readFileSync(path.join(STAGING, file), "utf8"));
  const pairs = pairsFrom(run.source_text || "");

  const byEmail = {};
  const groups = {};
  const passwords = {};
  for (const [email, password] of pairs) {
    passwords[email] = password;
    const fp = fingerprint(password);
    byEmail[email] = fp;
    (groups[fp] = groups[fp] || []).push(email);
  }
  // Only a fingerprint shared by two or more accounts is a link worth keeping;
  // a unique password relates an account to nothing.
  const shared = {};
  for (const [fp, emails] of Object.entries(groups)) {
    const unique = [...new Set(emails)].sort();
    if (unique.length > 1) shared[fp] = unique;
  }
  const linkedEmails = new Set(Object.values(shared).flat());
  for (const email of Object.keys(byEmail)) {
    if (!linkedEmails.has(email)) delete byEmail[email];
  }

  const out = {
    _comment:
      "Passwords from the Raven File infostealer sample table. passwords maps each operator address to the password it was reported with. clusters groups addresses that share one, keyed by sha256(password)[:12] as a cluster id, and by_email maps a clustered address to that id; two addresses in one cluster are very likely one operator. See scripts/build-password-links.js.",
    source: "https://theravenfile.com/2025/08/19/unmasking-dprk-it-workers-email-address-patterns-as-hiring-red-flags/",
    generated: new Date().toISOString().slice(0, 10),
    clusters: shared,
    by_email: byEmail,
    passwords: Object.fromEntries(Object.entries(passwords).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileAtomic(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `wrote ${Object.keys(passwords).length} passwords, ${Object.keys(byEmail).length} linked emails in ${Object.keys(shared).length} reuse clusters to ${path.relative(ROOT, OUT)}`
  );
}

main();
