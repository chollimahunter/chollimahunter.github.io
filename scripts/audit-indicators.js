#!/usr/bin/env node
/**
 * audit-indicators.js
 * ==============================================================
 * Flags scraped indicators that look like they belong to somebody other than
 * an operator: the vendor who published the report, the researcher who wrote
 * it, or the company that was robbed.
 *
 * Run before promoting a batch:
 *
 *   node scripts/audit-indicators.js            # the whole file
 *   node scripts/audit-indicators.js --since 2026-09-11
 *
 * WHY THIS EXISTS
 * ---------------
 * The guards in scripts/lib/ioc-normalize.js are denylists of specific
 * observed false positives -- CITATION_ACCOUNTS, EMAIL_DOMAIN_DENYLIST -- and
 * they carry a standing instruction to add only what has actually been seen in
 * output. That instruction is right, and it means those lists are always one
 * batch behind: they cannot catch a vendor nobody has yet watched slip
 * through.
 *
 * Two batches in a row proved the cost. One indexed three Plainbit team
 * addresses, PolySwarm's contact inbox and the OFAC address readers are told
 * to send tips to. The next indexed Microsoft's and Ably's GitHub
 * organisations and the Medium account of a protocol DPRK stole from -- the
 * victim, published under the name of the people who robbed it. Both were
 * found by a person searching the site's own pages afterwards.
 *
 * This is the check that runs before, not after. It flags rather than deletes:
 * every rule here has real false positives of its own, and deciding which side
 * of the line a value falls on is the reviewer's job. What the script owes
 * them is a short list instead of ten thousand records.
 */

const fs = require("fs");
const path = require("path");

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
const SCRAPED = path.join(ROOT, "src", "_data", "iocs", "scraped-iocs.json");
const SOURCES = path.join(ROOT, "src", "_data", "iocs", "scrape-sources.json");

/**
 * Language that marks the sentence around a value as describing somebody who
 * was attacked. Deliberately narrow: "compromised" alone appears in half this
 * corpus as a description of what the operator did, so only the phrasings that
 * put a name on the receiving end are here.
 */
const VICTIM_NEAR =
  /\b(victim|targeted|was\s+(?:hacked|breached|robbed|stolen\s+from)|stolen\s+from|drained|exploit(?:ed)?\s+(?:the|a)\b|belong(?:s|ed)?\s+to\s+(?:the\s+)?(?:legitimate|real|genuine)|impersonat\w+|posing\s+as|spoof\w+|masquerad\w+)\b/i;

/** Words that mark a value as the reporting side rather than the reported. */
const REPORTER_LOCAL =
  /^(?:info|press|media|contact|support|sales|hello|help|abuse|security|report|reports|research|threatintel|ti|soc|csirt|cert|dfc|ctrc|hivemind)$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The distinctive word in a host: plainbit.co.kr -> plainbit, ably.com -> ably. */
function brandOf(host) {
  if (!host) return null;
  const labels = host.split(".").filter((l) => !/^(?:com|org|net|io|co|kr|jp|cn|uk|de|fr|ru|ai|dev|news|blog|www)$/.test(l));
  return labels.length ? labels[labels.length - 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const sinceAt = args.indexOf("--since");
  const since = sinceAt !== -1 ? args[sinceAt + 1] : null;

  const doc = JSON.parse(fs.readFileSync(SCRAPED, "utf8"));
  const config = JSON.parse(fs.readFileSync(SOURCES, "utf8"));

  const publisherHosts = new Set();
  const publisherBrands = new Set();
  for (const entry of [...config.sources, ...config.not_scraped]) {
    const host = hostOf(entry.url);
    if (!host) continue;
    publisherHosts.add(host);
    const parent = host.replace(/^(?:www|blog|news|research|labs?|docs?|en|ko|ja|zh|ti|hub|sect|about|cloud|security|asec|api)\./, "");
    publisherHosts.add(parent);
    const brand = brandOf(parent);
    if (brand && brand.length > 3) publisherBrands.add(brand);
  }

  const findings = [];
  for (const record of doc.records) {
    const sources = record.sources || [];
    if (since && !sources.some((s) => (s.pulled_at || "") >= since)) continue;

    const reasons = [];
    const value = String(record.value);

    // A mail domain, or an account handle, that is a source publisher's own.
    if (record.ioc_type === "email_address") {
      const [local, domain] = value.split("@");
      const host = (domain || "").toLowerCase();
      // GitHub's per-user address form. The domain is github.com's, which is a
      // source host, but the address identifies the account rather than the
      // platform and is one of the better indicators in this corpus.
      const platformIssued = /(?:^|\.)noreply\.github\.com$/.test(host);
      if (
        !platformIssued &&
        host &&
        (publisherHosts.has(host) || publisherHosts.has(host.split(".").slice(-2).join(".")))
      ) {
        reasons.push("address at a source publisher's domain");
      }
      if (local && REPORTER_LOCAL.test(local)) {
        reasons.push(`role address (${local}@) rather than a person's`);
      }
    } else {
      const handle = value.split("/").filter(Boolean).pop() || "";
      const bare = handle.replace(/^@/, "").toLowerCase();
      if (bare.length > 3 && publisherBrands.has(bare)) {
        reasons.push(`handle matches a source publisher's name (${bare})`);
      }
    }

    // Victim language in the sentence the value was pulled from.
    for (const source of sources) {
      const context = source.context || "";
      if (!context) continue;
      const at = context.toLowerCase().indexOf(value.toLowerCase().slice(0, 40));
      if (at === -1) continue;
      const window = context.slice(Math.max(0, at - 160), at + value.length + 160);
      const hit = window.match(VICTIM_NEAR);
      if (hit) reasons.push(`victim language nearby ("${hit[0]}")`);
      break;
    }

    if (reasons.length) {
      findings.push({ record, reasons: [...new Set(reasons)] });
    }
  }

  if (!findings.length) {
    console.log(since ? `No flags on records pulled since ${since}.` : "No flags.");
    return;
  }

  console.log(`${findings.length} indicator(s) to review${since ? ` (pulled since ${since})` : ""}:\n`);
  for (const { record, reasons } of findings) {
    console.log(`  ${record.ioc_type}  ${record.value}`);
    console.log(`    ${reasons.join("; ")}`);
    const first = (record.sources || [])[0];
    if (first) console.log(`    ${first.url}`);
    console.log("");
  }
  console.log(
    "Nothing is deleted. Decide each one: a real operator value stays, a\n" +
      "publisher's or a victim's goes, as a sealed exclusion on its source\n" +
      "(CONTENT_GUIDE.md, npm run seal)."
  );
}

main();
