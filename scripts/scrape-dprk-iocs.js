#!/usr/bin/env node
/**
 * scrape-dprk-iocs.js
 * ==============================================================
 * Fetches the curated threat-intelligence sources listed in
 * src/_data/iocs/scrape-sources.json and extracts identity-focused
 * indicators (email addresses, LinkedIn profiles, GitHub accounts) with the
 * source URL, source title, and a readable quote of the prose each one was
 * found in.
 *
 * Writes one run file per source to _drafts/iocs/<date>-<slug>.json. Nothing
 * this script writes reaches a page: scripts/ingest-scraped-iocs.js merges
 * staged runs into src/_data/iocs/scraped-iocs.json, and the weekly workflow
 * opens a PULL REQUEST rather than committing, so a human reviews every new
 * identifier before it goes live.
 *
 * Usage:
 *   node scripts/scrape-dprk-iocs.js --all
 *   node scripts/scrape-dprk-iocs.js --changed-only
 *   node scripts/scrape-dprk-iocs.js --full
 *   node scripts/scrape-dprk-iocs.js --source https://example.com/report
 *
 * --all reads the sources not yet in scripts/data/scraped-sources.txt.
 * --changed-only does that, then rechecks up to --budget already-read sources
 * (default 250), oldest check first, and extracts only those whose readable
 * text changed. A source with no recorded hash is fetched and its hash
 * recorded without extracting, so the first pass does not re-ingest the
 * corpus. --full extracts every source regardless. Per-source ETag,
 * Last-Modified and text hash live in scripts/data/scrape-state.json.
 * Other flags: --timeout <seconds> per request (default 45), --concurrency <n>
 * hosts at once (default 4).
 *
 * Prints "CHANGED=true"/"CHANGED=false" as its last line of stdout so the
 * GitHub Actions workflow can branch on it.
 *
 * This script fetches public web pages with an honest user agent, one request
 * at a time per host with a delay between them. It does not crawl: it reads
 * exactly the sources listed in the data file. Open-ended crawling was the
 * single largest source of false positives in the proof-of-concept this
 * replaces.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  EMAIL_PATTERN,
  LINKEDIN_PATTERN,
  GITHUB_PATTERN,
  GITHUB_BARE_REPO_PATTERN,
  NPM_PACKAGE_PATTERN,
  NPM_TABLE_ROW_PATTERN,
  PAYLOAD_URL_PATTERN,
  PAYLOAD_URL_ROW_PATTERN,
  normalizePayloadUrl,
  isExcludedPayloadUrl,
  isHostileTableRow,
  FILE_HASH_PATTERN,
  normalizeFileHash,
  isInsideUrlPath,
  looksLikeHashContext,
  indicatorSectionLabel,
  isStandaloneOnLine,
  typedTableRow,
  rowDescribesOperatorInfra,
  HASH_TYPE_CELL,
  isLabelledContract,
  DOMAIN_IN_BLOCK_PATTERN,
  isExcludedDomain,
  normalizeDomain,
  CHROME_WEBSTORE_PATTERN,
  CHROME_EXTENSION_ID_PATTERN,
  PLATFORM_ACCOUNTS,
  platformAccountPattern,
  normalizePlatformAccount,
  WALLET_PATTERNS,
  walletChain,
  normalizeWallet,
  SKYPE_PATTERN,
  normalizeSkype,
  HOSTED_SITE_PATTERN,
  normalizeHostedSite,
  IPV4_PATTERN,
  normalizeIpv4,
  ASN_PATTERN,
  normalizeAsn,
  PHONE_PATTERN,
  normalizePhone,
  looksLikePhoneContext,
  isPhoneBoilerplate,
  defang,
  decodeCfEmail,
  normalizeEmail,
  normalizeLinkedin,
  normalizeGithub,
  normalizeNpmPackage,
  normalizeChromeExtension,
  looksLikeExtensionContext,
  looksLikeVictimContext,
  isPackageManifestLink,
  looksLikeMaliciousContext,
  isChromeSection,
  isVictimSection,
  isExcludedEmail,
  isEmailFragment,
  isExcludedUrl,
  accountsOwningSources,
  hostOf,
  contextFor,
  safeDecode,
} = require("./lib/ioc-normalize.js");

const { pdfToText } = require("./lib/pdf-text.js");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { seal } = require("./lib/private-data.js");
const { decodeEntities, stripCfEmailPlaceholder } = require("./lib/html-entities.js");

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
const SOURCES_PATH = path.join(ROOT, "src", "_data", "iocs", "scrape-sources.json");
const STAGING_DIR = path.join(ROOT, "_drafts", "iocs");
const SEEN_PATH = path.join(__dirname, "data", "scraped-sources.txt");
const STATE_PATH = path.join(__dirname, "data", "scrape-state.json");
/** A Wayback snapshot at a fixed timestamp never changes, so it is never rechecked. */
const ARCHIVE_SNAPSHOT = /^https?:\/\/web\.archive\.org\/web\/\d+/;

const USER_AGENT =
  "ChollimaHunterScraper/1.0 (+https://chollimahunter.github.io/; public DPRK threat-intel index)";
/**
 * Raised from 5 MB after a vendor blog carrying ~108 npm packages, 64 addresses
 * and 30 domains — the densest single page this corpus has found — was rejected
 * at 9 MB. A modern marketing site routinely ships that much JavaScript, inlined
 * imagery and font payload around a few kilobytes of prose, and parseHtml throws
 * all of it away before the extractor sees anything. The cap is still here to
 * stop something pathological, so it rejects rather than truncating: a
 * silently shortened body would drop indicators without saying so.
 */
const MAX_BODY_BYTES = 12_000_000;
/**
 * PDFs get their own, larger cap. The authoritative sources in this corpus are
 * sanctions reports and government advisories, and those run to a hundred-odd
 * pages of embedded fonts and figures — MSMT 2025/2 alone is 7.6 MB. The 5 MB
 * cap is right for an HTML article and would reject every one of them. The
 * final Panel of Experts report, S/2024/215, is 615 pages and 47 MB, and its
 * annexes hold over two hundred wallet addresses, so the cap sits above it.
 */
const MAX_PDF_BYTES = 64_000_000;
const REQUEST_DELAY_MS = 1000;
// text/markdown is here because an Obsidian Publish site serves its pages as
// Markdown and its HTML as a loader shell with no prose in it at all. The
// parser already reads Markdown headings, so nothing downstream changes.
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "text/markdown", "application/xhtml+xml"];
const PDF_CONTENT_TYPE = "application/pdf";

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------


/**
 * The date the source published its reporting, which is what tells a reader
 * whether an indicator is current or five years stale.
 *
 * Tried in descending order of reliability: the explicit article metadata most
 * publishing platforms emit, then schema.org JSON-LD, then a <time> element.
 * Returns null rather than guessing — a wrong date is worse than no date, and
 * the site renders an em dash where this is missing.
 */
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";

/**
 * Last resort: a date printed near the top of the article itself.
 *
 * Several sources publish no structured date at all — ketman.org writes
 * "By: blackbigswan / 2025-04-01" under the title, chollima-group.io writes
 * "19 November 2025" — and returning null there dated 137 indicators to the
 * scrape day instead of the reporting.
 *
 * Restricted to the opening of the page so it cannot pick up a date mentioned
 * later in the body, and it takes the FIRST plausible match, which is the
 * byline position on every source seen so far.
 */
function dateFromLeadingText(text) {
  const head = text.slice(0, 1500);
  const candidates = [
    /\b(20\d{2})-(\d{2})-(\d{2})\b/,
    new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\s+(20\\d{2})\\b`, "i"),
    new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "i"),
  ];
  for (const pattern of candidates) {
    const match = head.match(pattern);
    if (!match) continue;
    const parsed = new Date(match[0].replace(/(\d)(st|nd|rd|th)/gi, "$1"));
    if (Number.isNaN(parsed.getTime())) continue;
    const iso = parsed.toISOString().slice(0, 10);
    if (iso >= "2000-01-01" && iso <= new Date().toISOString().slice(0, 10)) return iso;
  }
  return null;
}

function extractPublishedDate(html) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time|datePublished|publish[-_]?date|date)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time|datePublished)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const parsed = new Date(match[1]);
    if (Number.isNaN(parsed.getTime())) continue;
    const iso = parsed.toISOString().slice(0, 10);
    // Reject anything implausible for a threat-intel report — a mis-parsed
    // string is more likely than a genuine 1970 or far-future publication.
    if (iso < "2000-01-01" || iso > new Date().toISOString().slice(0, 10)) continue;
    return iso;
  }
  return null;
}

/**
 * Containers that hold the full text of other articles after the one being
 * read, hidden by CSS and so invisible in a browser. Darktrace's blog renders
 * the bodies of its latest posts into `section_blogs-continued` on every
 * article, and that set rotates: a DPRK report was credited with IP addresses
 * from a Mexican government impersonation case and a China-linked intrusion.
 * Everything from the first of these markers on is dropped.
 */
const CONTINUATION_MARKERS = [/<section\b[^>]*\bclass="[^"]*\bsection_blogs-continued\b/i];

function cutAtContinuation(html) {
  let end = html.length;
  for (const marker of CONTINUATION_MARKERS) {
    const match = marker.exec(html);
    if (match && match.index < end) end = match.index;
  }
  return html.slice(0, end);
}

/**
 * Extracts the title, the publication date, and the readable prose of a page.
 *
 * Link targets are deliberately not returned — see extractFrom() for why a
 * report's outbound links are not treated as indicators. Taking a character
 * window across text and links combined, as the proof-of-concept did, also
 * produced "context" that was just a run of adjacent URLs.
 */
function parseHtml(html) {
  // Cloudflare-obfuscated addresses are decoded in place so they read as
  // ordinary text to the extractor below, with their surrounding prose intact.
  const deobfuscated = html.replace(
    /<(\w+)([^>]*?)data-cfemail="([0-9a-fA-F]+)"([^>]*)>(?:\s*(?:\[email(?:\s|&#160;|&nbsp;)+protected\])?\s*<\/\1>)?/g,
    (match, tag, before, hex) => {
      try {
        return decodeCfEmail(hex);
      } catch {
        return match;
      }
    }
  );

  const titleMatch = deobfuscated.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : null;

  const stripped = cutAtContinuation(deobfuscated)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Defanging happens here, per segment, rather than over the finished string.
  // It shortens text (a bracketed dot becomes one character), so applying it
  // afterwards would slide every recorded heading offset out of alignment with
  // the text the extractor scans.
  const toText = (fragment) =>
    defang(
      stripCfEmailPlaceholder(decodeEntities(
        fragment
          .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre)\b[^>]*>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
      ))
    )
      .replace(/[ \t\r\f\v]+/g, " ")
      // Collapsed here rather than over the finished string for the same
      // reason as the defang: a later pass would shorten the text and slide
      // every recorded heading offset.
      .replace(/\n{3,}/g, "\n\n");

  // Build the text in segments split at heading boundaries, recording where
  // each heading lands. An indicator inside an appendix table has no sentence
  // to quote, but the heading it sits under ("Email Addresses", "Indicators of
  // Compromise") says where in the report it was found — which is the thing a
  // reader actually wants when there is no prose.
  const headings = [];
  let text = "";
  for (const segment of stripped.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i)) {
    if (/^<h[1-6]/i.test(segment)) {
      // Some sites style their headings with the Markdown hashes left visible,
      // so the <h2> text really is "## IOCs". Recording that verbatim puts the
      // hashes on the published page, where they read as a rendering fault.
      // Requiring whitespace after the hashes keeps a heading like "#1 threat"
      // intact.
      const label = toText(segment)
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^#{1,6}\s+/, "");
      if (label) {
        headings.push({ offset: text.length, label });
        text += "\n" + label + "\n";
      }
      continue;
    }
    text += toText(segment);
  }

  // A plain-text or Markdown source has no <h1-6> to split on, so the section
  // guard would have nothing to work with and every indicator would land
  // unlocated — including any sitting under a victim heading. ATX headings
  // ("## Cluster name") carry the same information.
  if (!headings.length) {
    // ATX ("## Cluster name") and setext (a line underlined with === or ---),
    // which is what hand-maintained plain-text indicator dumps tend to use.
    const patterns = [
      /^[ \t]*#{1,6}[ \t]+(.+)$/gm,
      /^[ \t]*(\S.{2,78})[ \t]*\r?\n[ \t]*(?:={3,}|-{3,})[ \t]*$/gm,
      // A line in capitals ending in a colon, which is the third convention
      // these dumps use and the one Unit 42's timely-threat-intel files are
      // written in: "SHA256 HASHES FOR FILES ASSOCIATED WITH THIS ACTIVITY:"
      // and then the digests, one per line. Without it the 90-character label
      // window reaches the first value and no further, which is the same
      // truncation the section guard was written to fix for HTML appendices --
      // it just never applied to plain text, because there was no heading to
      // find. Capitals are required, so ordinary mixed-case prose ending in a
      // colon is not mistaken for a label.
      /^[ \t]*([A-Z0-9][A-Z0-9 \t,.'"()/&#+-]{4,88}:)[ \t]*$/gm,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const label = match[1].replace(/\s+#*\s*$/, "").trim();
        if (label) headings.push({ offset: match.index, label });
      }
    }
    headings.sort((a, b) => a.offset - b.offset);
  }

  const published = extractPublishedDate(deobfuscated) || dateFromLeadingText(text);

  return { title, text, headings, published };
}

/** The nearest heading at or before a position in the extracted text. */
function sectionAt(headings, index) {
  let label = null;
  for (const heading of headings) {
    if (heading.offset > index) break;
    label = heading.label;
  }
  return label;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Each extractor pairs a pattern with the normalizer that decides identity, so
 * two spellings of one account collapse to a single indicator. `display` is the
 * human-readable label for URL-shaped indicators; for a value that is its own
 * label it stays null.
 */
const EXTRACTORS = [
  {
    ioc_type: "email_address",
    pattern: EMAIL_PATTERN,
    normalize: normalizeEmail,
    exclude: (value, opts) => isExcludedEmail(value, opts),
    // A masked tail, a URL's login part or a single-use bounce address;
    // see isEmailFragment.
    guard: (prose, index, match) => !isEmailFragment(prose, index, match),
    // Gmail ignores dots and plus-tags, so the stored value is the mailbox the
    // address reaches. Where the page printed something else — and in this
    // corpus it often prints the same mailbox dotted a different way in every
    // report — the printed form is kept as the display.
    display: (value, raw) => (raw && String(raw).toLowerCase() !== value ? String(raw) : null),
  },
  {
    // No guard, the same shape as email_address: normalizeIpv4 already drops
    // private, loopback, reserved and documentation ranges (isReservedIpv4 in
    // ioc-normalize.js), and that exclusion is doing the same job the seed-host
    // and role-address denylists do for other types. A positive malicious-
    // context gate was tried against the staged corpus and rejected — in this
    // corpus a report's own operator IPs (VPN egress points, C2 hosts, the
    // login IP behind a compromised account) are not printed next to a
    // victim's IP the way a wallet address is, so the gate only cost recall
    // without buying any precision: of 60 sampled public matches, 59 sat next
    // to language like "malicious", "attacker" or "DPRK" already, and the one
    // that did not was still a genuine operator IP the gate would have dropped.
    ioc_type: "ip_address",
    pattern: IPV4_PATTERN,
    normalize: normalizeIpv4,
    display: () => null,
  },
  {
    ioc_type: "linkedin_profile",
    pattern: LINKEDIN_PATTERN,
    normalize: normalizeLinkedin,
    urlShaped: true,
    platform: "linkedin.com",
    // An account names a person. Same reasoning as the package gate below:
    // a report's appendix often lists the accounts that were taken over
    // alongside the ones doing the taking, and getting that backwards
    // publishes a legitimate maintainer as a DPRK indicator.
    guard: (prose, index) => !looksLikeVictimContext(prose, index),
    display: (value) => safeDecode(value.split("/").filter(Boolean).pop()),
  },
  {
    ioc_type: "github_profile",
    pattern: GITHUB_PATTERN,
    normalize: normalizeGithub,
    urlShaped: true,
    platform: "github.com",
    // The manifest check matters most here: a malicious release's bugs and
    // homepage fields point at the project it impersonates, not at its author.
    guard: (prose, index) =>
      !looksLikeVictimContext(prose, index) && !isPackageManifestLink(prose, index),
    display: (value) => value.split("/").pop(),
  },
  {
    // The same account type, matched from a bare owner/repo path that a
    // qualifying phrase has already identified as GitHub. See
    // GITHUB_BARE_REPO_PATTERN for why the host-anchored pattern misses these.
    ioc_type: "github_profile",
    pattern: GITHUB_BARE_REPO_PATTERN,
    capture: 1,
    normalize: (owner) => normalizeGithub("https://github.com/" + owner),
    urlShaped: true,
    platform: "github.com",
    guard: (prose, index) => !looksLikeVictimContext(prose, index),
    display: (value) => value.split("/").pop(),
  },
  {
    // See FILE_HASH_PATTERN: a bare hex run is far too weak, so the value must
    // also carry an algorithm label nearby, sit outside a URL path, and pass the
    // usual malicious-context gate. Across the staged corpus those three take
    // 1,002 raw matches down to 23.
    ioc_type: "file_hash",
    pattern: FILE_HASH_PATTERN,
    normalize: normalizeFileHash,
    guard: (prose, index, match, opts = {}) => {
      if (isInsideUrlPath(prose, index)) return false;
      // A row of a one-cell-per-line table: "File" above the digest, the
      // sample's description below. The victim question is asked of the row's
      // own cells only, because the character window below reaches into the
      // previous row ("Get victim machine OS information") and refused two of
      // eSentire's EtherRAT digests for a command the sample ran. See
      // typedTableRow.
      const row = typedTableRow(prose, index, match[0].length);
      if (row && HASH_TYPE_CELL.test(row.cell)) {
        return !looksLikeVictimContext(row.cell + " " + row.description, 0);
      }
      // Unconditional, and deliberately ahead of everything below: a report
      // names the files its subject forged or impersonated inside an appendix
      // as readily as in prose, and neither a block heading nor an appendix
      // heading answers that question.
      if (looksLikeVictimContext(prose, index)) return false;
      // A row of a labelled block. The heading says which algorithm the digest
      // is, which is what looksLikeHashContext looks for, and a block headed
      // "MD5" inside an "IoC" section exists to list values its author treats
      // as malicious, which is what looksLikeMaliciousContext looks for. Both
      // proximity gates fail on the same input for the same reason -- they
      // read a fixed window and a column of bare digests has nothing in that
      // window but more digests -- so the block answers both. Measured on the
      // Genians APT37 report, the two gates between them passed 3 of 11
      // hashes; the block test passes all 11.
      if (
        isStandaloneOnLine(prose, index, match[0].length) &&
        indicatorSectionLabel(prose, index) === "hash"
      ) {
        return true;
      }
      // A row of a table-style appendix, where the label is per row rather than
      // a heading, so the block walk above never fires. The appendix heading
      // stands in for the malicious-context window, which runs out after the
      // first few rows for exactly the same reason. See indicatorAppendixStart.
      if (index >= (opts.appendixAt ?? Infinity)) {
        return looksLikeHashContext(prose, index);
      }
      // A keyword_exempt source is a machine-kept indicator list (Cisco
      // Talos's IOC repository, say): no headings, no prose, every line an
      // entry. A digest alone on its line there is an entry, not a stray.
      if (opts.bareList && isStandaloneOnLine(prose, index, match[0].length)) return true;
      return looksLikeHashContext(prose, index) && looksLikeMaliciousContext(prose, index);
    },
    display: (value) => value.slice(0, 12) + "...",
  },
  {
    // Domains an operator stood up, taken only from a labelled indicator block.
    // ------------------------------------------------------------------
    // normalizeDomain's own comment records why this type was left to the
    // curated files: a general domain extractor fires on every vendor, CDN,
    // news site and reference link a report mentions. That is measured, not
    // assumed -- a domain-shaped pattern matches 12,695 times across the
    // staged corpus, led by gmail.com at 5,210, then github.com, outlook.com,
    // cloudflare.com, akamai.net and fastly.net. None of those is an
    // indicator.
    //
    // The gate that makes the type safe is the one the hash extractor above
    // now uses: the value must stand alone on its line inside a block whose
    // heading names it as network infrastructure. Writing "C2" above a list is
    // an act of attribution by the report's author, and it is the same signal
    // defanging would carry. Defanging itself is not usable here -- across all
    // 116 staged runs the corpus contains zero defanged domains, so a gate
    // built on it would extract nothing.
    //
    // What the block rule refuses is as important as what it takes. kmsec's
    // npm feed lists per-release domains one to a line, mixing real C2 with
    // pino.stream, www.apple.com, www.w3.org and github.com; every release
    // there is introduced by a maintainer line, which is prose, so the walk
    // stops before it reaches a heading and none of them are taken.
    //
    // WHAT THIS GATE CANNOT DECIDE, AND WHO DECIDES IT
    // ------------------------------------------------------------------
    // A C2 heading says the malware talked to the value. It does not say the
    // operator registered it, and this type asserts that it did. Those come
    // apart constantly, because planting a webshell on somebody else's site is
    // ordinary tradecraft for these actors: Genians' APT37 report lists
    // ycpatent.co.kr, printory.kr and fe01.co.kr under "C2", and its own prose
    // describes the webshell as having been REGISTERED at those sites, which
    // makes them compromised businesses rather than operator infrastructure.
    // ReversingLabs' list, a few lines of the same shape, is the opposite --
    // clob-polymarket.com and winstonjs.site are typosquats nobody registered
    // by accident.
    //
    // Nothing in the text separates the two, so this extractor does not try.
    // It stages candidates, and the reviewer of the pull request the workflow
    // opens is the one who establishes control before they are published. A
    // domain that turns out to be somebody's compromised website is dropped
    // there, not indexed here: naming a patent firm as DPRK infrastructure is
    // the failure this whole file is arranged to avoid.
    ioc_type: "domain",
    pattern: DOMAIN_IN_BLOCK_PATTERN,
    normalize: normalizeDomain,
    guard: (prose, index, match) => {
      if (!isStandaloneOnLine(prose, index, match[0].length)) return false;
      if (looksLikeVictimContext(prose, index)) return false;
      if (indicatorSectionLabel(prose, index) === "network") return true;
      // A one-cell-per-line table: "Domain" above the value and a description
      // below that says C2. See typedTableRow.
      const row = typedTableRow(prose, index, match[0].length);
      return !!row && /^(?:domains?|host(?:name)?s?)$/.test(row.cell) && rowDescribesOperatorInfra(row.description);
    },
    exclude: (value, opts) => isExcludedDomain(value, opts),
    display: () => null,
  },
  {
    ioc_type: "npm_package",
    pattern: NPM_PACKAGE_PATTERN,
    // The name is in the capture group; the match itself is the registry URL
    // that qualified it.
    capture: 1,
    normalize: normalizeNpmPackage,
    guard: (prose, index) =>
      looksLikeMaliciousContext(prose, index) && !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    // A row of an indicator table whose type column says "npm package". The
    // victim guard stays on, and a row that does not call the package hostile
    // is refused; a name in a sentence is never taken. See NPM_TABLE_ROW_PATTERN.
    ioc_type: "npm_package",
    pattern: NPM_TABLE_ROW_PATTERN,
    capture: 1,
    normalize: normalizeNpmPackage,
    guard: (prose, index) =>
      isHostileTableRow(prose, index) && !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    ioc_type: "chrome_extension",
    pattern: CHROME_WEBSTORE_PATTERN,
    capture: 1,
    normalize: normalizeChromeExtension,
    guard: (prose, index) =>
      looksLikeMaliciousContext(prose, index) && !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    ioc_type: "chrome_extension",
    pattern: CHROME_EXTENSION_ID_PATTERN,
    normalize: normalizeChromeExtension,
    guard: (prose, index) =>
      looksLikeExtensionContext(prose, index) &&
      looksLikeMaliciousContext(prose, index) &&
      !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  // The rest of a persona's account spread — Telegram, X, Medium, dev.to,
  // freelancing and board profiles — from one table in ioc-normalize.js. They
  // take the same victim guard as the LinkedIn and GitHub extractors above,
  // for the same reason: a report names the accounts that were impersonated
  // alongside the ones doing the impersonating.
  //
  // `platform` matters here. Several of these hosts sit on HOST_DENYLIST
  // precisely so that a stray social link never becomes an indicator; naming
  // the platform tells isExcludedUrl that this match is the account itself
  // rather than a share button.
  // Wallets. Both gates are mandatory and not negotiable: a report prints the
  // victim's address beside the operator's, and the two are identical in shape.
  // The positive gate is what makes the difference — without it this extractor
  // reports 385 Ethereum addresses across the staged corpus instead of 30, and
  // the extras are exchanges, contracts and the people who were robbed.
  ...Object.values(WALLET_PATTERNS).map((pattern) => ({
    ioc_type: "wallet_address",
    pattern,
    normalize: normalizeWallet,
    // A value the report calls a smart contract is filed as one, not as a
    // wallet, and its label is the attribution: EtherHiding reports name the
    // contract that holds the C2 address in a sentence that may sit paragraphs
    // from the language the proximity window looks for.
    typeFor: (prose, index, match) =>
      isLabelledContract(prose, index, match[0].length) ? "smart_contract_address" : null,
    guard: (prose, index, match) =>
      !looksLikeVictimContext(prose, index) &&
      (looksLikeMaliciousContext(prose, index) ||
        (isLabelledContract(prose, index, match[0].length) &&
          looksLikeMaliciousContext(prose, index, 1200))),
    display: (value) => walletChain(value),
  })),
  {
    // An ASN is unremarkable hosting metadata until a report says whose it is,
    // so this takes the same positive-malicious/not-victim gate as a wallet or
    // npm package rather than a plain exclusion list — see the comment on
    // ASN_PATTERN in ioc-normalize.js for the measured gate survival rate.
    ioc_type: "asn",
    pattern: ASN_PATTERN,
    normalize: normalizeAsn,
    guard: (prose, index) =>
      looksLikeMaliciousContext(prose, index) && !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    // A digit run is the commonest thing in a report, so a telephone number is
    // taken only where something labels it: a phone word on its own table row,
    // within 40 characters before it, or a heading about phone numbers. See
    // looksLikePhoneContext, and a publisher's address block or a WHOIS record
    // is refused by isPhoneBoilerplate. normalizePhone then refuses any run whose country
    // it cannot tell, which removes timestamps, identifiers and prices.
    ioc_type: "phone_number",
    pattern: PHONE_PATTERN,
    normalize: normalizePhone,
    guard: (prose, index, match, opts = {}) =>
      !isInsideUrlPath(prose, index) &&
      looksLikePhoneContext(prose, index, opts.section) &&
      !isPhoneBoilerplate(prose, index, match[0].length) &&
      !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    // A Skype ID needs no positive gate: nothing else in a report is shaped
    // like live:.cid.<hex>, so there is no false-positive surface to guard.
    ioc_type: "skype_account",
    pattern: SKYPE_PATTERN,
    normalize: normalizeSkype,
    guard: (prose, index) => !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    // Free-hosting sites. The capture group is the hostname without any scheme
    // the page happened to write.
    ioc_type: "hosted_site",
    pattern: HOSTED_SITE_PATTERN,
    capture: 1,
    normalize: normalizeHostedSite,
    guard: (prose, index) =>
      looksLikeMaliciousContext(prose, index) && !looksLikeVictimContext(prose, index),
    display: () => null,
  },
  {
    // A URL on a paste or JSON-bin service. The host alone is shared by every
    // user of the service, so the stored value is the whole URL; see
    // PAYLOAD_URL_HOSTS. Both gates apply, since a report also links the
    // service's own documentation.
    ioc_type: "payload_url",
    pattern: PAYLOAD_URL_PATTERN,
    capture: 1,
    normalize: normalizePayloadUrl,
    guard: (prose, index) =>
      looksLikeMaliciousContext(prose, index) && !looksLikeVictimContext(prose, index),
    exclude: (value, opts) => isExcludedPayloadUrl(value, opts),
    display: () => null,
  },
  {
    // A URL in a row of an indicator table whose type column says url or
    // malware and whose row calls itself hostile. This is the only way a URL
    // on a host outside PAYLOAD_URL_HOSTS is taken. It does not make the host
    // a domain record: a row names an address the malware fetched, not who
    // registered it. See PAYLOAD_URL_ROW_PATTERN.
    ioc_type: "payload_url",
    pattern: PAYLOAD_URL_ROW_PATTERN,
    capture: 1,
    normalize: normalizePayloadUrl,
    guard: (prose, index) =>
      isHostileTableRow(prose, index) && !looksLikeVictimContext(prose, index),
    exclude: (value, opts) => isExcludedPayloadUrl(value, opts),
    display: () => null,
  },
  {
    // A URL alone on a line below a "URL" type cell, with a description cell
    // below it that says C2 or malware. See typedTableRow. A nodejs.org download
    // listed in the same table says neither and is not taken.
    ioc_type: "payload_url",
    pattern: /\bhttps?:\/\/[^\s<>"'\x60)\]]+/gi,
    normalize: normalizePayloadUrl,
    guard: (prose, index, match) => {
      const row = typedTableRow(prose, index, match[0].length);
      return (
        !!row && /^urls?$/.test(row.cell) && rowDescribesOperatorInfra(row.description) &&
        !looksLikeVictimContext(prose, index)
      );
    },
    exclude: (value, opts) => isExcludedPayloadUrl(value, opts),
    display: () => null,
  },
  ...PLATFORM_ACCOUNTS.filter((spec) => spec.auto_extract !== false).map((spec) => ({
    ioc_type: spec.ioc_type,
    pattern: platformAccountPattern(spec),
    normalize: normalizePlatformAccount(spec),
    urlShaped: true,
    platform: spec.canonical,
    guard: (prose, index) => !looksLikeVictimContext(prose, index),
    display: (value) => safeDecode(value.split("/").filter(Boolean).pop()),
  })),
];

/**
 * True when a context window is an IOC appendix table rather than a sentence.
 *
 * Reports commonly end with a bare list of indicators, and a character window
 * taken across one yields "context" that is just the neighbouring addresses.
 * Quoting that on the site would be noise dressed up as evidence, so these are
 * recorded with no quote and the citation alone carries the meaning.
 */
function contextIsIndicatorList(context) {
  const emails = context.match(new RegExp(EMAIL_PATTERN.source, "g")) || [];
  const urls = context.match(/https?:\/\//g) || [];
  return emails.length + urls.length >= 3;
}

/**
 * Extraction reads a report's prose only, never its links.
 *
 * A page's outbound links are not claims about the accounts they point to —
 * they are navigation, author bios, and citations. Harvesting them turns a
 * publisher's own GitHub org and every researcher it credits into "indicators".
 * Threat reports write real IOCs as text precisely so they are copyable and not
 * clickable, so prose-only extraction loses very little and avoids implicating
 * people the report was crediting rather than reporting on.
 */
/**
 * Where a page's reference list starts, or Infinity when it has none.
 *
 * A bibliography is chrome, but isChromeSection cannot see it: the list often
 * carries no heading of its own, so every entry in it inherits the last real
 * section of the article. Nocturnal Knight's PolinRider post ends that way, and
 * the run took two indicators out of the references under the heading "The IDE
 * as the New Perimeter" -- a GitHub account belonging to the maintainer of a
 * Unicode library the article cites as background, and the IP behind the URL of
 * the author's own earlier post. Both would have named someone the article is
 * citing rather than reporting on.
 *
 * Matched at a line start so an ordinary sentence using the word in passing
 * does not truncate the article, and taken as the LAST such marker, because a
 * contents list near the top can name the section before the section arrives.
 *
 * TWO CONDITIONS BEYOND THE MARKER, both learned by breaking real sources.
 *
 * The marker must sit in the last third of the document. A first version
 * truncated SentinelOne's report at the word "Reference" appearing alone in a
 * table cell -- it is the "Reason" column's value on a row of scam-recruiter
 * registrations -- and dropped 21 of that source's 43 indicators.
 *
 * And nothing that announces an indicator appendix may follow it. ANY.RUN's
 * IT-worker report puts "Further Reading" BEFORE its IOC section, which is a
 * perfectly ordinary way to end an article's prose and then append the data;
 * truncating there dropped all 8 of that source's indicators. Where an
 * appendix follows the marker, the marker was not the end of the reporting and
 * this returns Infinity rather than guessing where the bibliography stops.
 */
const APPENDIX_MARKER = /indicators?\s+of\s+compromise|^[ \t]*ioc[s]?\b|\bappendix\b/im;

/**
 * Where a report's indicator appendix begins, or Infinity.
 *
 * The companion to indicatorSectionLabel, for the shape that one cannot read.
 * A heading-style appendix prints "SHA256" above a column of digests, and the
 * walk backwards finds it. A table-style appendix instead gives every row its
 * own label -- GitLab's reads "IOC | Type | Description", so each digest is
 * followed by the word SHA256 and then a sentence describing the sample. The
 * walk stops at that sentence, correctly, because a row of prose is where a
 * block ends.
 *
 * Those rows already satisfy looksLikeHashContext, since the label is right
 * there. What they fail is looksLikeMaliciousContext, and for the same reason
 * the heading-style ones did: it reads a fixed window, the language that calls
 * the campaign malicious sits in the prose above the appendix, and it reaches
 * only the first rows. Measured on GitLab's September writeup, all 11 digests
 * carry their SHA256 label and 3 sit close enough to malicious wording, which
 * is why that source was ingested holding one hash.
 *
 * An appendix heading is the author saying the whole section lists indicators,
 * so it answers the malicious question for every row under it, once. This
 * deliberately does not extend to the victim question: a report names the files
 * its subject forged inside the appendix as readily as outside, so
 * looksLikeVictimContext keeps being asked per value.
 *
 * The heading must be a heading, not the phrase in a sentence, and it must sit
 * in the last third of the document. "Indicators of compromise play a crucial
 * role in investigations" is a line ReversingLabs actually opens with, and
 * reading it as the start of an appendix would hand the rest of the article
 * the gate it is supposed to earn.
 */
const APPENDIX_HEADING =
  /^[ \t#*\d.)-]*(?:appendix[^\n]{0,40}|indicators?\s+of\s+compromise|iocs?|ioc\s*\(indicator[^\n]{0,40}\))[ \t:*-]*$/gim;

function indicatorAppendixStart(prose) {
  let at = Infinity;
  for (const match of prose.matchAll(APPENDIX_HEADING)) {
    if (match.index < prose.length / 2) continue;
    if (match.index < at) at = match.index;
  }
  return at;
}

function referenceListStart(prose) {
  const marker = /^[ \t]*(?:references?(?:[ \t]*(?:&|and)[ \t]*further[ \t]+reading)?|further[ \t]+reading|bibliography|works[ \t]+cited)[ \t]*:?[ \t]*$/gim;
  let at = Infinity;
  for (const match of prose.matchAll(marker)) at = match.index;
  if (at === Infinity) return at;
  // A bibliography belongs at the end. Anything earlier is a table cell or a
  // section that the article goes on from.
  if (at < prose.length * (2 / 3)) return Infinity;
  // An indicator appendix after the marker means the reporting had not ended.
  if (APPENDIX_MARKER.test(prose.slice(at))) return Infinity;
  return at;
}

function extractFrom(prose, headings, opts) {
  const found = new Map();
  const referencesAt = referenceListStart(prose);
  const appendixAt = indicatorAppendixStart(prose);

  const record = (extractor, rawValue, context, origin, section, typeOverride) => {
    const ioc_type = typeOverride || extractor.ioc_type;
    const value = extractor.normalize(rawValue);
    if (!value) return;
    if (extractor.exclude && extractor.exclude(value, opts)) return;
    // The host-based exclusions only mean anything for URL-shaped indicators;
    // an npm name or an extension id has no host to check.
    if (extractor.urlShaped && isExcludedUrl(value, { ...opts, platform: extractor.platform })) return;

    const key = `${ioc_type} ${value}`;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, {
        ioc_type,
        value,
        // The raw match is passed alongside the normalized value so an extractor
        // can keep what the page actually printed. Only email uses it today: a
        // Gmail address is stored as the mailbox it reaches, and the dotted form
        // the report published is worth showing beside it.
        display: extractor.display(value, rawValue),
        context,
        context_origin: origin,
        section,
      });
      return;
    }
    // Prefer a real prose quote over an appendix-table sighting of the same value.
    if (existing.context_origin !== "text" && origin === "text" && context) {
      existing.context = context;
      existing.context_origin = "text";
      existing.section = section;
    }
    if (!existing.section && section) existing.section = section;
  };

  for (const extractor of EXTRACTORS) {
    const pattern = new RegExp(extractor.pattern.source, extractor.pattern.flags);
    for (const match of prose.matchAll(pattern)) {
      const section = sectionAt(headings, match.index);
      // Chrome is not reporting, and a victim list is not an indicator list.
      if (isChromeSection(section) || isVictimSection(section)) continue;
      // Anything past the reference list is somebody the article cites.
      if (match.index >= referencesAt) continue;
      // The match is passed for the guards that need the matched length; the
      // older guards take the first two arguments and ignore it.
      if (extractor.guard && !extractor.guard(prose, match.index, match, { appendixAt, bareList: opts.bareList, section })) continue;
      const raw = match[extractor.capture || 0];
      if (!raw) continue;
      const context = contextFor(prose, match.index, match.index + match[0].length);
      // The surrounding text is kept even for appendix-table sightings. It is
      // not a readable sentence there — it is the neighbouring indicators —
      // but it is what lets a reviewer judge whether a match belongs, which
      // matters more now that matching is deliberately loose. The origin says
      // which kind it is so the page can present them differently.
      // A quote that holds a password is kept as it stands. Operator
      // passwords are tracked here: a reused one links accounts, and the
      // string itself is something a defender can search a log for.
      const typeOverride = extractor.typeFor ? extractor.typeFor(prose, match.index, match) : null;
      if (contextIsIndicatorList(context)) {
        record(extractor, raw, context, "list", section, typeOverride);
      } else {
        record(extractor, raw, context, "text", section, typeOverride);
      }
    }
  }

  // A value the page calls a contract in one place and says nothing about in
  // another is one record, typed as the contract.
  for (const [key, hit] of found) {
    if (hit.ioc_type === "wallet_address" && found.has(`smart_contract_address ${hit.value}`)) {
      found.delete(key);
    }
  }

  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * `prior` carries the validators from the last read, when there was one, and
 * turns the request conditional; a 304 comes back as { notModified: true }.
 */
async function fetchPage(url, { timeoutMs = 45000, prior = null } = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (prior && prior.etag) headers["If-None-Match"] = prior.etag;
  if (prior && prior.last_modified) headers["If-Modified-Since"] = prior.last_modified;
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 304) return { notModified: true };
  const validators = {
    etag: response.headers.get("etag") || null,
    last_modified: response.headers.get("last-modified") || null,
  };

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  // raw.githubusercontent.com serves every PDF as application/octet-stream,
  // so a deck or report kept in a repository was refused outright. A generic
  // binary type is taken as a PDF only when the path says so, and the body
  // must then open with the PDF signature below.
  const pdfByPath =
    contentType.startsWith("application/octet-stream") && /\.pdf$/i.test(new URL(response.url || url).pathname);
  const isPdf = contentType.startsWith(PDF_CONTENT_TYPE) || pdfByPath;
  if (!isPdf && !ALLOWED_CONTENT_TYPES.some((type) => contentType.startsWith(type))) {
    throw new Error(`unsupported content-type "${contentType || "unknown"}"`);
  }

  const cap = isPdf ? MAX_PDF_BYTES : MAX_BODY_BYTES;

  // Enforced while streaming rather than after arrayBuffer(): a server that
  // lies about (or omits) content-length would otherwise have the whole body
  // buffered in memory before the length check ever ran.
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        throw new Error(`body exceeds ${cap} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const buffer = Buffer.concat(chunks);
  if (pdfByPath && buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`unsupported content-type "${contentType}" (named .pdf but not a PDF)`);
  }
  return { isPdf, body: isPdf ? buffer : buffer.toString("utf8"), validators };
}

/**
 * A PDF's text in the shape parseHtml returns, so scrapeSource has one path.
 *
 * `headings` is deliberately empty. A PDF has no heading elements — a heading
 * is a run of text in a larger font, and inferring one from glyph sizes would
 * be a guess. Every indicator from a PDF therefore lands unlocated, which is a
 * known and honest state the rest of the pipeline already handles; inventing
 * section labels would be worse, because the victim-section guard trusts them.
 */
function parsePdf(buffer, url) {
  const { text, title, published, pages } = pdfToText(buffer);
  if (!text || text.replace(/\s/g, "").length < 200) {
    throw new Error(`PDF yielded no extractable text across ${pages} page(s) — likely scanned images`);
  }
  return { title: title || titleFromPdfUrl(url), text: defang(text), headings: [], published };
}

/**
 * A readable title from a PDF's filename, for the many that carry no /Info
 * /Title. Without this the citation on every indicator page reads as a 200
 * character URL — MSMT publishes under a UUID-prefixed filename that already
 * spells the report's name out, and most agencies do something similar.
 */
/**
 * A readable title for a raw GitHub file with no <title> of its own, one layer
 * up from titleFromPdfUrl: a raw.githubusercontent.com URL serves the file as
 * plain text, so the HTML title fallback finds nothing and the citation used to
 * print the whole URL. "owner/repo — path/file" is what the page is called.
 */
function titleFromRawGithubUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "raw.githubusercontent.com") return null;
    const [, owner, repo, , ...rest] = u.pathname.split("/");
    const tail = safeDecode(rest.join("/")).replace(/.(md|txt)$/i, "");
    return owner && repo && tail ? `${owner}/${repo} — ${tail}` : null;
  } catch {
    return null;
  }
}

function titleFromPdfUrl(url) {
  try {
    const name = safeDecode(new URL(url).pathname.split("/").pop() || "");
    const cleaned = name
      .replace(/\.pdf$/i, "")
      .replace(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-?/i, "")
      .replace(/[_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

function slugFor(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  let tail = segments.pop() || "index";
  // A generic file name says nothing about which list it is: Elastic's
  // rustbucket and ref7001 releases are both ecs-indicators.ndjson, and one
  // overwrote the other's run file. Such a name keeps the path above it.
  if (/^(readme|index|ioc|iocs|indicators|ecs-indicators|stix-bundle)(\.[a-z]+)?$/i.test(tail)) {
    tail = [...segments.slice(-3), tail].join("-");
  }
  // A query string is part of what distinguishes a source: the UN documents
  // API serves every report from one path and names the report in `s=`, and
  // five Panel of Experts reports once overwrote each other's run file.
  const query = [...parsed.searchParams.values()].join("-");
  return `${parsed.hostname}-${tail}${query ? `-${query}` : ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function loadSeen() {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  return new Set(
    fs
      .readFileSync(SEEN_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );
}

function recordSeen(urls) {
  if (!urls.length) return;
  const header = fs.existsSync(SEEN_PATH)
    ? ""
    : "# Sources already scraped by scripts/scrape-dprk-iocs.js.\n" +
      "# Delete a line to have that source re-read on the next run.\n";
  fs.appendFileSync(SEEN_PATH, header + urls.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------

/**
 * A source may name values it carries that are not indicators, under
 * `exclude` in scrape-sources.json, each with the reason. The generic rules
 * catch a whole class of false positive; this catches one value in one
 * report, where the report itself is the reason. Jamf's Contagious Interview
 * write-up names a Telegram bot belonging to the web3 project sharing the C2
 * host and stops short of calling the project a front; Socket's Packagist
 * report prints the compromised maintainer's repository in a mitigation
 * command. Both sources carry clean indicators around those values, and
 * without this the choice was to take the source with the victim in it or
 * hold the source and lose the indicators.
 *
 * Applied again on ingest, so a value excluded after it was harvested is
 * removed from the merged set as well.
 */
function dropExcludedValues(artifacts, source) {
  const excluded = new Set((source.exclude || []).map((entry) => entry.sealed));
  if (!excluded.size) return artifacts;
  return artifacts.filter((artifact) => !excluded.has(seal(artifact.value)));
}

/**
 * A fetched page's readable text, plus the hash of that text. The hash is what
 * change detection compares, so it moves when the prose does and not when a
 * sidebar or a cache-busting script tag does.
 */
function readPage(page, url) {
  // Already defanged by parseHtml, per segment, so `headings` offsets line up.
  const parsed = page.isPdf ? parsePdf(page.body, url) : parseHtml(page.body);
  return { ...parsed, sha256: crypto.createHash("sha256").update(parsed.text).digest("hex") };
}

function scrapeSource(source, parsed, opts) {
  const { title, text: prose, headings, published } = parsed;

  // A machine-generated indicator list carries no prose at all, so the keyword
  // net refuses it however well attributed it is: JPCERT/CC's ioc.txt is a
  // column of addresses, and the campaign is named by the repository around it
  // rather than by the file. `keyword_exempt` in scrape-sources.json lifts the
  // net for one source and must be a STRING saying where the attribution comes
  // from instead, so the exemption is never a bare flag somebody can set
  // without explaining. It is a hole in a safety net: the net exists under
  // human curation, and this is the curator writing down what they checked.
  const exemption =
    typeof source.keyword_exempt === "string" && source.keyword_exempt.trim()
      ? source.keyword_exempt.trim()
      : null;
  // The page title counts as well as the body: a write-up titled for the
  // group it analyses ("Lazarus Targets the Financial Sector ...") and then
  // written in terms of its malware never names the group again in prose.
  const vetted = `${title || ""}\n${prose}`.toLowerCase();
  const named = opts.keywords.some((word) => vetted.includes(word));
  if (opts.keywords.length && !exemption && !named) {
    throw new Error("no DPRK-related keyword found on page; refusing to extract");
  }
  if (exemption && !named) {
    // Said out loud on every run, so a standing exemption stays visible rather
    // than becoming a line in a data file nobody reads again.
    console.log(`    keyword net lifted for this source: ${exemption}`);
  }

  const extracted = extractFrom(prose, headings, {
    excludedHosts: opts.excludedHosts,
    excludedAccounts: opts.excludedAccounts,
    // An exempted source is a curated indicator list with no prose, so a
    // digest alone on its line is one of its entries; see the hash guard.
    bareList: Boolean(exemption),
  });
  const artifacts = dropExcludedValues(extracted, source);
  const pulledAt = new Date().toISOString().slice(0, 10);

  return {
    source: {
      // Decoded once here, whether the entry was written by hand or queued by
      // discovery: an &amp; copied out of a page's markup is not in the address.
      url: decodeEntities(source.url),
      // A source may name itself in scrape-sources.json, which wins over
      // whatever the document or its filename yields. Needed where a publisher
      // serves a PDF from an opaque endpoint: DOJ's forfeiture complaint lives
      // at a path ending `/dl`, so the filename fallback titled it "dl" and
      // every citation drawn from it read that way on the sources page.
      title: decodeEntities(source.title) || title || titleFromRawGithubUrl(source.url) || source.url,
      publisher: source.publisher || null,
      published: published,
      // Which DPRK activity cluster this source is reporting on. Curated per
      // source in scrape-sources.json rather than inferred from the page: a
      // report can mention several cluster names while reporting on one, and
      // guessing wrong mislabels every indicator it contributes.
      campaign: source.campaign || [],
      pulled_at: pulledAt,
      // Hashes the extracted text, so it changes when the page's readable
      // content changes and not merely because the run happened again.
      source_sha256: parsed.sha256,
    },
    extraction: { method: "regex", model: null },
    // Retained so the ingest can verify every extracted value literally appears
    // in the page it is attributed to. This is what catches a fabricated value.
    source_text: prose,
    artifacts,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")).sources || {};
}

/** Sorted by URL so a run's diff shows only the sources it touched. */
function saveState(state) {
  const sources = {};
  for (const url of Object.keys(state).sort()) sources[url] = state[url];
  writeFileAtomic(
    STATE_PATH,
    JSON.stringify(
      {
        _comment:
          "Written by scripts/scrape-dprk-iocs.js. Per source: the validators and readable-text hash of the last read, and when it was last checked. --changed-only rechecks the oldest last_fetched first. Delete an entry to have that source re-baselined.",
        sources,
      },
      null,
      2
    ) + "\n"
  );
}

function numberFlag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number`);
  return n;
}

/**
 * Hosts are worked in parallel, but each host's own sources one at a time with
 * a delay between them, so no publisher sees more than one request in flight.
 */
async function runByHost(jobs, concurrency, worker) {
  const byHost = new Map();
  for (const job of jobs) {
    const host = hostOf(job.source.url) || job.source.url;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(job);
  }
  // Busiest hosts first, so the longest queue is not the one left running alone.
  const queues = [...byHost.values()].sort((a, b) => b.length - a.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, queues.length) }, async () => {
    while (next < queues.length) {
      const queue = queues[next++];
      for (const [index, job] of queue.entries()) {
        await worker(job);
        if (index < queue.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
        }
      }
    }
  });
  await Promise.all(runners);
}

async function main() {
  const args = process.argv.slice(2);
  const sourceFlagIndex = args.indexOf("--source");
  const explicitUrl = sourceFlagIndex !== -1 ? args[sourceFlagIndex + 1] : null;
  const full = args.includes("--full");
  const changedOnly = args.includes("--changed-only");
  const scrapeAll = args.includes("--all") || full || changedOnly;

  if (args.includes("--ai")) {
    console.error(
      "AI-assisted extraction is not implemented yet. Regex extraction only.\n" +
        "See docs/scrape-dprk-iocs.md for what an AI mode must do before it can be enabled."
    );
    console.log("CHANGED=false");
    process.exitCode = 1;
    return;
  }

  if (!explicitUrl && !scrapeAll) {
    console.error(
      "Usage: node scripts/scrape-dprk-iocs.js --all | --changed-only | --full | --source <url>"
    );
    console.log("CHANGED=false");
    process.exitCode = 1;
    return;
  }

  const timeoutMs = numberFlag(args, "--timeout", 45) * 1000;
  const concurrency = Math.floor(numberFlag(args, "--concurrency", 4));
  const budget = Math.floor(numberFlag(args, "--budget", 250));

  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const excludedHosts = config.sources.map((entry) => hostOf(entry.url)).filter(Boolean);
  // The authors of any sources hosted on a code platform; see accountsOwningSources.
  const excludedAccounts = accountsOwningSources(config.sources.map((entry) => entry.url));
  const keywords = (config.keywords || []).map((word) => word.toLowerCase());
  const state = loadState();
  const seen = loadSeen();

  // "extract" writes a run; "recheck" writes one only when the text changed.
  let jobs;
  if (explicitUrl) {
    // An explicitly named source is always re-read, even if already recorded.
    jobs = [
      {
        source: config.sources.find((entry) => entry.url === explicitUrl) || { url: explicitUrl },
        mode: "extract",
      },
    ];
  } else {
    const fresh = config.sources.filter((entry) => !seen.has(entry.url));
    const read = config.sources.filter((entry) => seen.has(entry.url));
    jobs = fresh.map((source) => ({ source, mode: "extract" }));
    if (full) {
      jobs.push(...read.map((source) => ({ source, mode: "extract" })));
    } else if (changedOnly) {
      const due = read
        .filter((entry) => !ARCHIVE_SNAPSHOT.test(entry.url))
        .sort((a, b) =>
          ((state[a.url] || {}).last_fetched || "").localeCompare(
            (state[b.url] || {}).last_fetched || ""
          )
        )
        .slice(0, budget);
      jobs.push(...due.map((source) => ({ source, mode: "recheck" })));
    } else if (read.length) {
      console.log(`Skipping ${read.length} source(s) already scraped.`);
    }
  }

  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const tally = { extracted: 0, changed: 0, unchanged: 0, baselined: 0, failed: 0 };
  let sinceSave = 0;

  await runByHost(jobs, concurrency, async ({ source, mode }) => {
    const held = state[source.url];
    const checkedAt = new Date().toISOString();
    try {
      const page = await fetchPage(source.url, {
        timeoutMs,
        prior: mode === "recheck" ? held : null,
      });
      if (page.notModified) {
        state[source.url] = { ...held, last_fetched: checkedAt };
        delete state[source.url].last_error;
        tally.unchanged += 1;
        return;
      }
      const parsed = readPage(page, source.url);
      const entry = { ...page.validators, source_sha256: parsed.sha256, last_fetched: checkedAt };

      if (mode === "recheck" && (!held || !held.source_sha256)) {
        // First recheck of a source read before hashes were kept: record the
        // baseline only. Extracting here would re-ingest the whole corpus on
        // the first pass, from whatever the extractor now says about it.
        state[source.url] = entry;
        tally.baselined += 1;
        return;
      }
      if (mode === "recheck" && held.source_sha256 === parsed.sha256) {
        state[source.url] = entry;
        tally.unchanged += 1;
        return;
      }

      // A source's own host always excludes itself, even when the config
      // does not list it yet. --source takes a bare URL, so the triage pass
      // that reads a candidate before it is added ran with the publisher's
      // domain missing from this list, and three Plainbit team addresses and
      // PolySwarm's contact inbox were indexed as DPRK indicators because of
      // it. An address at the domain of the page it was found on belongs to
      // whoever published the page.
      // hostMatches works downwards -- it drops mail at a subdomain of a
      // listed host -- so a blog on a subdomain has to contribute its parent
      // too, or ctrc@plainbit.co.kr survives a run of blog.plainbit.co.kr.
      // Only the obvious content prefixes are stripped: going further would
      // reach a public suffix like co.kr and exclude a whole country.
      const ownHost = hostOf(source.url);
      const ownHosts = [];
      if (ownHost) {
        ownHosts.push(ownHost);
        const parent = ownHost.replace(
          /^(?:www|blog|news|research|labs?|docs?|en|ko|ja|zh|ti|hub|sect|about|cloud|security)\./,
          ""
        );
        if (parent !== ownHost && parent.split(".").length >= 2) ownHosts.push(parent);
      }
      const run = scrapeSource(source, parsed, {
        excludedHosts: [...excludedHosts, ...ownHosts],
        excludedAccounts,
        keywords,
      });
      const filename = `${run.source.pulled_at}-${slugFor(source.url)}.json`;
      fs.writeFileSync(
        path.join(STAGING_DIR, filename),
        JSON.stringify(run, null, 2) + "\n",
        "utf8"
      );
      state[source.url] = entry;
      if (!seen.has(source.url)) {
        seen.add(source.url);
        recordSeen([source.url]);
      }
      tally[mode === "recheck" ? "changed" : "extracted"] += 1;
      console.log(
        `  ${source.url}${mode === "recheck" ? " (changed)" : ""}\n` +
          `    ${run.artifacts.length} indicator(s) -> _drafts/iocs/${filename}`
      );
    } catch (err) {
      // A source that fails is not recorded as seen, so the next run retries
      // it. A recheck that fails still moves to the back of the rotation, or
      // one dead page would take the front of the queue every week.
      if (held) state[source.url] = { ...held, last_fetched: checkedAt, last_error: err.message };
      tally.failed += 1;
      console.error(`  ${source.url}\n    FAILED: ${err.message}`);
    } finally {
      // Saved as it goes, so a run killed by the job timeout keeps its progress.
      if (++sinceSave >= 25) {
        saveState(state);
        sinceSave = 0;
      }
    }
  });

  if (!explicitUrl) saveState(state);

  const written = tally.extracted + tally.changed;
  console.log(
    `\nScraped ${written} source(s) (${tally.extracted} new or forced, ${tally.changed} changed), ` +
      `${tally.unchanged} unchanged, ${tally.baselined} baselined, ${tally.failed} failure(s).`
  );
  console.log("Run scripts/ingest-scraped-iocs.js to merge staged runs into the site data.");
  console.log(`CHANGED=${written > 0}`);
  // Partial results stay written above; the exit code is what tells the
  // workflow that the run read too little to be trusted as a pass.
  if (jobs.length > 0 && tally.failed > jobs.length / 2) {
    console.error(`More than half of the sources failed (${tally.failed} of ${jobs.length}).`);
    process.exitCode = 1;
  }
}

// Required rather than run when a harness wants extractFrom alone, to test the
// extractors against text it already holds without fetching anything.
if (require.main === module) {
  main().catch((err) => {
    console.error("Scrape failed:", err.message);
    console.log("CHANGED=false");
    process.exitCode = 1;
  });
} else {
  module.exports = { extractFrom, EXTRACTORS, fetchPage, readPage };
}
