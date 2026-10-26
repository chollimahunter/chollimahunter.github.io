#!/usr/bin/env node
/**
 * etherhiding-review-gate.js
 * ==============================================================
 * Prints whether the latest EtherHiding refresh may be merged unattended and
 * what it adds: one "review: ..." line per reason to hold, one "new: ..." line
 * per new on-chain value, then NEEDS_REVIEW=true or NEEDS_REVIEW=false as the
 * last line. The decision is scripts/lib/etherhiding-review-gate.js; see its
 * header for what merges and what holds. Exit code is 0 either way, 1 only if
 * the findings file is unreadable, which the workflow treats as a hold.
 *
 * Usage: node scripts/etherhiding-review-gate.js [latest.json] [previous-latest.json]
 * Without the previous file the answer is always NEEDS_REVIEW=true.
 */

const fs = require("fs");
const path = require("path");
const { gateDecision } = require("./lib/etherhiding-review-gate.js");

const FILE = process.argv[2] || path.join(__dirname, "..", "src", "_data", "etherhidingFindings", "latest.json");
const MAX_LINES = 80;

// The values are written by the operator, and these lines are posted into a
// GitHub issue inside a code block: no backtick, newline or overlong line
// survives to break out of it.
const inert = (s) => String(s).replace(/[`\r\n]/g, "'").slice(0, 240);

let latest;
try {
  latest = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (err) {
  console.error(`cannot read ${FILE}: ${err.message}`);
  console.log("NEEDS_REVIEW=true");
  process.exit(1);
}

let previous = null;
if (process.argv[3]) {
  try {
    previous = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  } catch (err) {
    console.error(`cannot read ${process.argv[3]}: ${err.message}`);
  }
}
// The lines reach a notification email, where a live host could become a
// link: IPs and the quoted values an operator writes are defanged
// (hxxps://host[.]com, 1[.]2[.]3[.]4). Addresses and hashes are left alone.
const defangValue = (v) => v.replace(/^http/i, "hxxp").replace(/\./g, "[.]");
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const defang = (s) => s.replace(/"([^"]*)"/g, (_, v) => `"${defangValue(v)}"`).replace(IPV4, (ip) => ip.replace(/\./g, "[.]"));

// The C2 a run adds, one line, ahead of the detail: a decoded IP or a
// written value, in first-seen order.
function c2Of(lines) {
  const out = [];
  for (const line of lines) {
    for (const m of line.matchAll(/"([^"]+)"/g)) out.push(m[1].replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, ""));
    for (const m of line.matchAll(IPV4)) out.push(m[0]);
  }
  return [...new Set(out)];
}

const { needsReview, reasons, fresh, total } = gateDecision(latest, previous);
const c2 = c2Of(fresh);
if (c2.length) console.log(`c2: ${inert(c2.map(defangValue).join(", "))}`);
for (const r of reasons) console.log(`review: ${inert(defang(r))}`);
for (const f of fresh.slice(0, MAX_LINES)) console.log(`new: ${inert(defang(f))}`);
if (fresh.length > MAX_LINES) console.log(`new: ... and ${fresh.length - MAX_LINES} more in latest.json`);
console.log(`${reasons.length} hold(s), ${fresh.length} new value(s), across ${total} recorded change(s)`);
console.log(`NEEDS_REVIEW=${needsReview}`);
