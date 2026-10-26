/**
 * ioc-normalize.js — shared IOC extraction, normalization and exclusion rules
 * ==========================================================================
 * Used by scripts/scrape-dprk-iocs.js (extraction), scripts/ingest-scraped-iocs.js
 * (merge + grounding), and scripts/sync-dtex-itworker-emails.js (Cloudflare decode).
 *
 * The normalizers here decide whether two sightings of an indicator are the
 * same indicator. Getting them wrong doesn't produce an error — it produces a
 * dataset with the same GitHub account listed four times under four spellings,
 * so each rule below is deliberate and the reasoning is recorded with it.
 */

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// Quantifiers are bounded to the RFC limits (64-character local part, 253-
// character domain) rather than open, because an open + over a long run of
// eligible characters with no @ or no dot behind it is scanned again from
// every starting position: quadratic time, and a 160 KB run of "1.1.1." in a
// scraped page cost 25 seconds before the bound.
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/g;
const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
/**
 * The scheme is optional on both. Hand-maintained indicator lists routinely
 * write "github.com/foo" and "linkedin.com/in/bar" with no https://, and
 * requiring one silently lost every account in those files.
 * normalizeGithub/normalizeLinkedin put the scheme back before parsing.
 *
 * This is a deliberately loose match. It will occasionally pick up an account
 * a report merely cites rather than accuses — that is the accepted trade: a
 * false positive sits next to its citation and can be removed, whereas a
 * missed account is invisible. The victim-context and section guards in
 * scrape-dprk-iocs.js remain the backstop against the one error that is NOT
 * acceptable, naming someone the report identified as a victim.
 */
const LINKEDIN_PATTERN =
  /\b(?:https?:\/\/)?(?:[\w-]{1,63}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9._%~:@+-]{1,200}\/?[^\s<>'"`)\]}]{0,300}/gi;
const GITHUB_PATTERN =
  /\b(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+(?:\/[^\s<>'"`)\]}]*)?/gi;

/**
 * An account written as a bare `owner/repo` path, qualified by the words that
 * say what it is.
 *
 * Reports routinely name a repository without the host once the sentence has
 * already said GitHub: GitLab's tech note on the September 2025 BeaverTail
 * variant writes "the GitHub repository /RominaMabelRamirez/dify", and the
 * host-anchored pattern above cannot see it. Three operator accounts in that
 * one report were invisible for this reason, including the account hosting the
 * payloads.
 *
 * The qualifying phrase has to sit immediately before the path, which is what
 * keeps this from matching every `foo/bar` on a page that happens to mention
 * GitHub somewhere. Owner names follow GitHub's own rule: alphanumerics and
 * hyphens, 39 characters at most.
 */
const GITHUB_BARE_REPO_PATTERN =
  /\bgithub\s+(?:repositor(?:y|ies)|repo|account|org(?:anization)?)\s+\/?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/[A-Za-z0-9._-]+/gi;

/**
 * npm packages are matched only from an explicit registry URL.
 *
 * Bare names in prose are not matched: an article about malicious packages also
 * names the legitimate packages they impersonate, and flagging `postcss`
 * because `postcss-optimizer` copied it would be a serious false positive
 * against a widely-used project. An `npm install <name>` form was tried and
 * removed — it matched the English sentence "treat every npm install as code
 * execution" and produced a package called `as`.
 */
const NPM_PACKAGE_PATTERN =
  /(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)/gi;

/**
 * An npm package named in a row of an indicator table, where a column states
 * the type: "dotenv-extend npm package malware N/A N/A Malicious NPM dependency
 * used to deliver malware". The row is the attribution. GitLab's year-in-review
 * lists seven packages this way and none of them has a registry URL or a
 * sentence around it, so the URL pattern above and the proximity gate on it
 * both found nothing to read.
 *
 * Anchored to the start of a line so the name is the first cell, and to the
 * words "npm package" immediately after it so a sentence that merely begins
 * with a package name does not qualify. The caller still requires the rest of
 * the row to say the package is hostile, see isHostileTableRow, which is what
 * keeps a legitimate dependency named in a row of "targeted packages" out.
 */
const NPM_TABLE_ROW_PATTERN =
  /^[ \t]*((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)[ \t]+npm[ \t]+packages?\b/gim;

const HOSTILE_ROW_WORDS =
  /malicious|malware|compromis|trojan|typosquat|backdoor|infostealer|dropper|loader|threat actor|attacker|insider/i;

/** True when the line holding a match, from the match on, states the entry is hostile. */
function isHostileTableRow(text, index) {
  const end = text.indexOf("\n", index);
  const row = text.slice(index, end < 0 ? text.length : end);
  return row.length <= 300 && HOSTILE_ROW_WORDS.test(row);
}

/**
 * File hashes, which a report gives for the sample it analysed.
 *
 * A bare run of hex is far too weak on its own, and the corpus shows exactly
 * how it fails: across the staged sources the pattern alone matches 1,002
 * times, and the 32-character matches are almost entirely URL path segments --
 * `chainlink-api-v3.cloud/api/service/token/<32 hex>` and gist ids like
 * `gist.githubusercontent.com/cuda-toolkit/<32 hex>/raw`. Publishing those as
 * file hashes would be type confusion dressed as an indicator.
 *
 * Three things are therefore required, and together they cut 1,002 matches to
 * 23: the value must not sit inside a URL path, a hash-type label must appear
 * near it, and the usual malicious-context gate must pass. The label is what
 * carries most of the weight, because an IOC table always names the algorithm
 * next to the digest. Everything else is left behind: 856 matches are dropped
 * for having no label, which is the fail-closed behaviour this file prefers
 * everywhere else.
 */
const FILE_HASH_PATTERN = /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi;
const HASH_LABEL = /sha-?256|sha-?1\b|sha-?512|md-?5|\bhash(?:es)?\b|checksum|shasum/i;

/**
 * Digests of a zero-byte file, in MD5, SHA-1 and SHA-256. A report lists one
 * when the file it analysed was empty at capture time (Huntress's BABYSHARK
 * write-up did, for normal.crp), and as an indicator it matches every empty
 * file on every host. One reached the index tagged Kimsuky before this guard.
 */
const EMPTY_FILE_DIGESTS = new Set([
  "d41d8cd98f00b204e9800998ecf8427e",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
]);

function normalizeFileHash(raw) {
  const value = String(raw).trim().toLowerCase();
  if (EMPTY_FILE_DIGESTS.has(value)) return null;
  return /^(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})$/.test(value) ? value : null;
}

/** True when the match sits inside a URL path or query rather than standing alone. */
function isInsideUrlPath(text, index) {
  const before = text.slice(Math.max(0, index - 200), index);
  return /[/=&?][^\s]{0,3}$/.test(before) && /https?:\/\/\S{0,180}$/.test(before);
}

/** True when a hash-algorithm label sits close enough to say what the digest is. */
function looksLikeHashContext(text, index, window = 90) {
  return HASH_LABEL.test(text.slice(Math.max(0, index - window), index + 64 + window));
}

/**
 * The label governing the indicator block a match sits in, or null.
 * ==========================================================================
 * The proximity gates above assume a report names an indicator's type next to
 * the value, which is how prose and two-column tables read. A vendor advisory
 * appendix does not. It prints the algorithm once as a heading and then lists
 * the values one per line:
 *
 *     7. IoC (Indicator of Compromise)
 *     MD5
 *     255155bad9af5e2c6cf550ff2a95219d
 *     abbb362cdfe14b56b3a13a2a55937ee4
 *     ... nine more ...
 *     C2
 *     oxenhan1.cafe24.com
 *     kmot.co.kr
 *     ... four more, then five addresses ...
 *
 * A fixed character window cannot read that. Measured against the Genians
 * APT37 report, looksLikeHashContext reaches the first three digests and then
 * runs out, so the source was ingested carrying 3 of its 11 hashes; the same
 * truncation takes 10 of 11 from GitLab's September writeup, 8 of 9 from Snyk
 * on StegaBin and 11 of 16 from Proofpoint. The label is not far away in any
 * sensible reading of the page -- it is directly above -- so widening the
 * window is the wrong fix, and it would also drag in whatever prose surrounds
 * a lone hash elsewhere. What is needed is the block, not a bigger radius.
 *
 * So this walks backwards a line at a time from the line the match sits on. It
 * steps over blank lines and over lines holding nothing but another indicator
 * value, because those are the block's other rows. It stops at the first line
 * that is prose, which is what ends a block. Only a heading reached without
 * crossing prose counts.
 *
 * That stopping rule is the whole safety argument, and it is what keeps the
 * domain extractor honest. kmsec's npm feed lists a hash per release with
 * benign domains beside it -- www.apple.com, www.w3.org, github.com -- each
 * standing alone on its own line, which is the shape this function otherwise
 * accepts. It fails closed there because every release is introduced by a
 * maintainer line ("davidchen1111 <davidchen1111@proton.me>") that is prose by
 * this test, so the walk stops before reaching any heading and those benign
 * domains are left where they are.
 */
const SECTION_LABELS = [
  {
    label: "hash",
    pattern: /^(?:md-?5|sha-?(?:1|256|384|512)|hashe?s?|checksums?|file\s+hashe?s?|sample\s+hashe?s?)\b/i,
  },
  {
    // Deliberately narrower than the set of headings that carry domains. A
    // heading saying "C2" asserts the operator controlled the value; one saying
    // "Domains", "URLs", "Hosts" or "Network indicators" asserts only that the
    // traffic was seen, and such a list mixes in whatever legitimate service
    // the malware happened to contact. Unit 42's list is the measured case:
    // under a bare "Domains" heading it carries mirotalk.io and
    // freeconference.io, real products a lure pointed victims at, beside the
    // operator's own regioncheck.net.
    label: "network",
    pattern:
      /^(?:c\s*(?:2|&\s*c)|command\s*(?:&|and)\s*control|malicious\s+(?:domains?|urls?|sites?|infrastructure))\b/i,
  },
];

/** A line carrying one indicator value and nothing else -- another row of the block. */
const VALUE_ONLY_LINE =
  /^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64}|\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?|(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,24}(?:[/:][^\s]*)?)$/i;

/**
 * A heading is short and is a label rather than a sentence. The length ceiling
 * matters: "C2" and "MD5" are headings, but a paragraph that opens with the
 * word "Domains" is prose and must not be read as one.
 */
function sectionLabelOf(line) {
  const trimmed = line
    .trim()
    .replace(/^[\s#*\d.)\-|]+/, "")
    .replace(/[|:\s]+$/, "");
  if (!trimmed || trimmed.length > 40) return null;
  for (const { label, pattern } of SECTION_LABELS) {
    if (pattern.test(trimmed)) return label;
  }
  return null;
}

function indicatorSectionLabel(text, index, maxLines = 60) {
  let cursor = text.lastIndexOf("\n", index - 1);
  for (let step = 0; step < maxLines && cursor > 0; step += 1) {
    const start = text.lastIndexOf("\n", cursor - 1) + 1;
    const line = text.slice(start, cursor);
    cursor = start - 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const label = sectionLabelOf(line);
    if (label) return label;
    // A Markdown code fence, or a bold-only sub-label inside the block
    // ("**Malicious LNK Files**"), sits between a heading and its values in a
    // raw README: Nextron's IOC repository lists nine digests that way under
    // "File Hashes (SHA-256)", and the walk stopped at the fence after the
    // first. Neither is prose, so step over both.
    if (/^`{3,}[\w-]*$/.test(trimmed) || /^\*\*[^*]{1,60}\*\*$/.test(trimmed)) continue;
    // Another row of the same block: keep walking. Anything else is prose,
    // which ends the block.
    if (!VALUE_ONLY_LINE.test(trimmed)) return null;
  }
  return null;
}

/** True when the match stands alone on its line, which is how a block lists values. */
function isStandaloneOnLine(text, index, length) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end < 0 ? text.length : end).trim();
  return line.toLowerCase() === text.slice(index, index + length).toLowerCase();
}

/**
 * A row of a table that a page renders one cell to a line, as eSentire's and
 * Sysdig's indicator appendices are:
 *
 *     Domain
 *     jariosos.com
 *     EtherRAT C2
 *
 * The type cell sits directly above the value and the description directly
 * below it. Neither shape the gates above read fits: the heading walk
 * (indicatorSectionLabel) stops at the type cell because "Domain" is a word,
 * not a heading or a value, and the proximity window finds no algorithm label
 * beside a SHA-256 whose type cell says only "File". Measured on eSentire's
 * EtherRAT post, that dropped ten domains and eight digests, and the same
 * table shape accounts for most of the indicators the scraper has never filed
 * from a vendor that renders its appendix this way.
 *
 * Returns the lowercased type cell and the description cell, or null when the
 * value is not alone on its line or the line above is not a recognised type
 * cell. The description is "" when the value is the last line of the page.
 */
const TABLE_TYPE_CELL =
  /^(?:domains?|host(?:name)?s?|ip(?:\s+address(?:es)?)?|urls?|files?|file\s+hash(?:es)?|hash(?:es)?|sha-?(?:1|256|512)|md5|smart\s+contract(?:\s+address)?|contract(?:\s+address)?|(?:\w+\s+)?wallet(?:\s+address)?)$/i;

function typedTableRow(text, index, length) {
  if (!isStandaloneOnLine(text, index, length)) return null;
  const nonBlankLine = (from, step) => {
    let cursor = from;
    while (cursor >= 0 && cursor <= text.length) {
      const start = step < 0 ? text.lastIndexOf("\n", cursor - 1) + 1 : cursor;
      const end = text.indexOf("\n", start);
      const line = text.slice(start, end < 0 ? text.length : end).trim();
      if (line) return line;
      if (step < 0) {
        if (start === 0) return null;
        cursor = start - 1;
      } else {
        if (end < 0) return null;
        cursor = end + 1;
      }
    }
    return null;
  };
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = text.indexOf("\n", index);
  const before = lineStart === 0 ? null : nonBlankLine(lineStart - 1, -1);
  if (!before || !TABLE_TYPE_CELL.test(before)) return null;
  const after = lineEnd < 0 ? "" : nonBlankLine(lineEnd + 1, 1) || "";
  return { cell: before.toLowerCase().replace(/\s+/g, " "), description: after };
}

const OPERATOR_INFRA_WORDS =
  /\bc2\b|\bc&c\b|command[ -]and[ -]control|malicious|malware|payload|loader|dropper|backdoor|phishing|exfil|staging|implant|beacon|botnet|\brat\b/i;
const NOT_OPERATOR_INFRA_WORDS =
  /compromised|legitimate|benign|official|vendor|download url|public|resolver|cdn|sinkhole|victim|reference/i;

/**
 * True when a table row's description cell says the value is the operator's
 * infrastructure rather than something the sample merely touched. A cell that
 * calls the host compromised is refused even where it also says "serving": the
 * report is describing somebody's hijacked website, which this index does not
 * publish as an operator domain.
 */
function rowDescribesOperatorInfra(description) {
  const text = String(description || "");
  if (!text || text.length > 160) return false;
  return OPERATOR_INFRA_WORDS.test(text) && !NOT_OPERATOR_INFRA_WORDS.test(text);
}

const HASH_TYPE_CELL = /^(?:files?|file hash(?:es)?|hash(?:es)?|sha-?(?:1|256|512)|md5)$/i;
const CONTRACT_TYPE_CELL = /^(?:smart contract(?: address)?|contract(?: address)?)$/i;
const CONTRACT_LABEL_BEFORE =
  /smart[\s-]+contract(?:\s+address)?(?:\s+at(?:\s+address)?)?\s*[:(]?\s*$/i;

/**
 * True when an Ethereum-shaped value is called a smart contract, in a type
 * cell or by the words immediately before it. A deployer or funding wallet is
 * a different thing on the same chain and keeps the wallet type; filing a
 * contract as a wallet misstates what it is and splits it from the watchlist
 * record for the same address.
 */
function isLabelledContract(text, index, length) {
  const row = typedTableRow(text, index, length);
  if (row && CONTRACT_TYPE_CELL.test(row.cell)) return true;
  return CONTRACT_LABEL_BEFORE.test(text.slice(Math.max(0, index - 60), index));
}

/** Chrome Web Store listing URLs, from which the extension id is taken. */
const CHROME_WEBSTORE_PATTERN =
  /\bhttps?:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/[^\s<>'"`)\]}]*?\/?([a-p]{32})\b/gi;

/**
 * A bare Chrome extension id. The id alphabet is a-p only, which makes a
 * 32-character run of those letters a strong signal, but the caller must still
 * confirm the surrounding text is talking about an extension — see
 * looksLikeExtensionContext.
 */
const CHROME_EXTENSION_ID_PATTERN = /\b[a-p]{32}\b/g;

/**
 * Cryptocurrency wallet addresses.
 * ==========================================================================
 * These are how an IT-worker operation gets paid, and reports name them. They
 * are also the single riskiest indicator class in this corpus, because a report
 * lists the victim's address in the same paragraph as the operator's and the
 * two are indistinguishable by shape. Both context gates are therefore
 * mandatory on the extractor — see EXTRACTORS in scrape-dprk-iocs.js.
 *
 * Measured over the 27 staged source texts: 385 raw Ethereum matches fall to 30
 * once the gates run. That 92% rejection rate is the guard working, not a bug.
 *
 * Solana is deliberately narrowed to 43-44 characters and a first character
 * that is not 1 or 3. Base58 is shared with Bitcoin, and a looser pattern
 * silently reported Bitcoin addresses such as 1HmqvgSXUVES1jn4TQPzk9dxo1NE8wim2T
 * as Solana keys.
 *
 * Tron shares Bitcoin's base58 alphabet but not its leading character — every
 * Tron address starts with a literal `T` followed by 33 base58 characters,
 * which is disjoint from Bitcoin's `1`/`3`/`bc1` prefixes and needs no extra
 * disambiguation. Measured over the staged corpus: 27 raw matches, one surviving
 * both gates — the sanctions annex tying a Tron address to the Alex Labs,
 * Maverick and EasyFi hacks. The same low survival rate the Ethereum comment
 * above describes is expected here for the same reason: an appendix table with
 * no "malicious" language beside each row fails the positive gate by design.
 */
const WALLET_PATTERNS = {
  ethereum: /\b0x[a-fA-F0-9]{40}\b/g,
  bitcoin: /\b(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
  solana: /\b[2-9A-HJ-NP-Za-km-z][1-9A-HJ-NP-Za-km-z]{42,43}\b/g,
  tron: /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g,
  // XRP Ledger classic addresses and Zcash transparent addresses. Both are
  // checksummed, and walletChain verifies the checksum, so the loose shapes
  // here (an `r` word of 25 to 35 letters would otherwise match) are narrowed
  // to real addresses before anything is indexed.
  xrp: /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g,
  zcash: /\bt[13][1-9A-HJ-NP-Za-km-z]{33}\b/g,
};

const BITCOIN_BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RIPPLE_BASE58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/**
 * Decodes a base58check string over the given alphabet and returns the payload
 * (version bytes included, checksum stripped), or null when a character is not
 * in the alphabet or the double-SHA-256 checksum does not match.
 */
function base58checkDecode(value, alphabet) {
  let n = 0n;
  for (const ch of value) {
    const digit = alphabet.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const leadingZeros = value.length - value.replace(new RegExp("^" + alphabet[0] + "+"), "").length;
  const bytes = Buffer.concat([Buffer.alloc(leadingZeros), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
  if (bytes.length < 5) return null;
  const payload = bytes.subarray(0, bytes.length - 4);
  const check = crypto
    .createHash("sha256")
    .update(crypto.createHash("sha256").update(payload).digest())
    .digest()
    .subarray(0, 4);
  return check.equals(bytes.subarray(bytes.length - 4)) ? payload : null;
}

/** An XRP Ledger classic address: version byte 0 and a 20-byte account id. */
function isXrpAddress(v) {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(v)) return false;
  const payload = base58checkDecode(v, RIPPLE_BASE58);
  return payload !== null && payload.length === 21 && payload[0] === 0;
}

/** A Zcash transparent address: t1 (P2PKH, 1CB8) or t3 (P2SH, 1CBD) over a 20-byte hash. */
function isZcashTransparentAddress(v) {
  if (!/^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(v)) return false;
  const payload = base58checkDecode(v, BITCOIN_BASE58);
  return (
    payload !== null &&
    payload.length === 22 &&
    payload[0] === 0x1c &&
    (payload[1] === 0xb8 || payload[1] === 0xbd)
  );
}

/** The chain an address belongs to, from its shape, or null if it is none of them. */
function walletChain(value) {
  const v = String(value).trim();
  // A run of hex exactly the length of an MD5, SHA-1 or SHA-256 digest is a
  // file hash, whatever else it resembles. An MD5 happens to fit the Bitcoin
  // shape when it starts with 1 or 3 and contains no 0, and CISA's COPPERHEDGE
  // analysis report put one in the index twice, labelled Bitcoin, before this.
  if (/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(v)) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(v)) return "Ethereum";
  // Aptos, which PolinRider uses as a dead drop: the same 0x prefix as
  // Ethereum over 64 hex characters rather than 40. Two curated addresses sat
  // in the index under a shape this function did not know, which an integrity
  // check caught by asking whether every published value still normalizes to
  // itself.
  if (/^0x[a-fA-F0-9]{64}$/.test(v)) return "Aptos";
  if (/^(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(v)) return "Bitcoin";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v)) return "Tron";
  if (isXrpAddress(v)) return "XRP Ledger";
  if (isZcashTransparentAddress(v)) return "Zcash";
  if (/^[2-9A-HJ-NP-Za-km-z][1-9A-HJ-NP-Za-km-z]{42,43}$/.test(v)) return "Solana";
  return null;
}

/**
 * Ethereum addresses lowercase, because EIP-55 mixed case is a checksum over
 * the same address and two spellings must not become two indicators. Bitcoin
 * Solana, XRP Ledger and Zcash keep their case: base58 is case-sensitive and changing it produces
 * a different, invalid address.
 */
function normalizeWallet(raw) {
  const value = String(raw).trim().replace(/[.,;:)\]}'"]+$/, "");
  const chain = walletChain(value);
  if (!chain) return null;
  // Both hex chains are case-insensitive, so a mixed-case spelling and a
  // lowercase one must not become two indicators.
  return chain === "Ethereum" || chain === "Aptos" ? value.toLowerCase() : value;
}

/**
 * ENS names, which reports give instead of an address (lightfury.eth).
 *
 * NOT auto-extracted — see auto_extract below. Gated over the staged corpus the
 * pattern kept three names, and all three belonged to researchers and traders
 * rather than operators (nonfungiblejc.eth, blau.eth, muranox.eth). A .eth name
 * in a crypto-crime report is as likely to be the person reporting as the
 * person reported on.
 */
const ENS_PATTERN = /\b[a-z0-9][a-z0-9-]{2,62}\.eth\b/gi;

function normalizeEns(raw) {
  const value = String(raw).trim().toLowerCase().replace(/[.,;:)\]}'"]+$/, "");
  return /^[a-z0-9][a-z0-9-]{2,62}\.eth$/.test(value) ? value : null;
}

/**
 * Skype IDs in the live:.cid.<hex> form.
 *
 * Skype is a documented contact channel for these operations, and this form is
 * distinctive enough to need no positive gate — nothing else in a report looks
 * like it. Only the victim guard applies, as for GitHub and LinkedIn.
 */
const SKYPE_PATTERN = /\blive:(?:\.cid\.)?[a-z0-9][a-z0-9._-]{5,64}\b/gi;

function normalizeSkype(raw) {
  const value = String(raw).trim().toLowerCase().replace(/[.,;:)\]}'"]+$/, "");
  return /^live:(?:\.cid\.)?[a-z0-9][a-z0-9._-]{5,64}$/.test(value) ? value : null;
}

/**
 * The name an operator presents under, where a source states it and publishes
 * no account or address alongside it.
 *
 * This type exists because the corpus was losing its most searchable material.
 * A researcher who interviews an applicant and concludes they are a DPRK IT
 * worker very often publishes exactly two things: the name the applicant gave,
 * and a photograph. Both are real evidence, and until this type existed neither
 * could be carried -- a dossier builds records from indicators, so a persona
 * with none produced no page, and thirty of those claims ended up on the
 * held-back list under a reason that read as restraint when the actual reason
 * was that there was no field to put them in. The site was publishing a name
 * when it happened to come with a GitHub account and hiding the same
 * researcher's identical claim when it did not, which is backwards: a hiring
 * team searches a name long before it searches a handle.
 *
 * CURATED ONLY. This is never auto-extracted and no pattern exists for it, for
 * a reason stronger than the one that keeps ens_name and x_account out of the
 * extractors. Those at least have a shape; a personal name has none, and the
 * names in a threat report belong overwhelmingly to researchers, victims,
 * journalists and prosecutors rather than to operators. The type is safe only
 * where a person read a source that named an operator outright and transcribed
 * it -- which is what the dossier files are.
 *
 * A value is a name a person could be introduced by: one to five words of
 * letters, with the hyphens, apostrophes and full stops names actually carry.
 *
 * A single given name is accepted. It was rejected at first on the grounds
 * that "Rami" is not something a defender can search for, and that was the
 * wrong test: nobody concludes anything from a first name alone, but an
 * operator who introduced himself as Rami on one call will do it again on the
 * next, and a reader who has just been handed that name is exactly who this
 * index is for. A weak indicator is not a false one, and the page it lands on
 * says who asserted it and shows the picture that came with it.
 *
 * Digits are excluded, which keeps the boundary with a handle: "cryptolegend92"
 * is an account name on some platform, and a handle whose platform a source
 * does not state stays on the held-back list rather than being relabelled a
 * person's name here.
 */
// A word may open with a quote, because a nickname set inside one is a form
// these names really take: "Eric 'Monkey' Manager" is a persona in the
// registry, and requiring every word to start with a letter dropped it.
const ALIAS_WORD = "[\\p{L}’'][\\p{L}’'.-]*";
const ALIAS_PATTERN = new RegExp(`^${ALIAS_WORD}(?: ${ALIAS_WORD}){0,4}$`, "u");

function normalizeAlias(raw) {
  const value = String(raw)
    .trim()
    .replace(/^["“”'']+|["“”'']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[,;:]+$/, "");
  if (value.length < 2 || value.length > 60) return null;
  return ALIAS_PATTERN.test(value) ? value : null;
}

/**
 * Registered domains an operator controls outright.
 *
 * Auto-extracted only from a labelled indicator block -- see
 * DOMAIN_IN_BLOCK_PATTERN and the domain entry in EXTRACTORS. On its own the
 * pattern is hopeless, which is why this type spent a long time restricted to
 * the curated files: a general domain extractor fires on every vendor, CDN,
 * news site and reference link a threat report mentions, 12,695 times across
 * the staged corpus, led by gmail.com. What makes it usable is the block, not
 * the shape. HOSTED_SITE_PATTERN below is the other safe subset, restricted to
 * subdomains of a known hosting platform.
 *
 * A profile URL on somebody else's platform is not a domain indicator: the
 * domain there belongs to the platform, not the operator. It gets an account
 * type of its own in PLATFORM_ACCOUNTS below, added when the first such
 * profile is transcribed; parking it in unextracted[] instead is refused at
 * build time by scripts/lib/dossiers.js. Nor does the
 * block gate establish control, which this type asserts and a "C2" heading
 * does not -- a compromised business's website is listed under exactly the same
 * heading as an operator's typosquat. That one is settled by a reviewer.
 */
const DOMAIN_PATTERN =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Reverse-DNS identifiers, which are not hostnames.
 *
 * An Android package name and an Apple bundle identifier are dot-separated
 * labels in the opposite order, so they satisfy every other rule here:
 * com.hyundaipay.hdac reached the index as a domain from a C2 block that was
 * really listing a mobile application. Two things have to be true together --
 * the leftmost label is one no hostname leads with, AND the rightmost label is
 * not a top-level domain. Testing only the first would throw away dev.azure.com
 * and me.example.org, which are ordinary hosts.
 */
const REVERSE_DNS_HEADS = new Set(["com", "org", "net"]);
const COMMON_TLDS = new Set([
  "com", "org", "net", "io", "co", "info", "biz", "dev", "app", "xyz", "me",
  "online", "site", "shop", "live", "click", "top", "cc", "tv", "pro", "cloud",
  "edu", "gov", "mil", "int", "eu", "uk", "kr", "jp", "cn", "ru", "de", "fr",
  "it", "es", "nl", "pl", "br", "in", "au", "ca", "us", "ke", "ng", "za",
  "ma", "tr", "ua", "vn", "th", "id", "sg", "hk", "tw", "ph", "my", "bio",
]);

function normalizeDomain(raw) {
  const value = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "")
    .replace(/[.,;:)\]}'"]+$/, "");
  if (!DOMAIN_PATTERN.test(value)) return null;
  // A dotted quad is an address, and has its own type.
  if (/^\d+(?:\.\d+)*$/.test(value)) return null;
  // A trailing label of one character, or an all-digit one, is not a TLD.
  const tld = value.slice(value.lastIndexOf(".") + 1);
  if (tld.length < 2 || /^\d+$/.test(tld)) return null;
  // Reverse-DNS is not DNS. An Android package name and an Apple bundle
  // identifier are dot-separated labels in the opposite order, so they satisfy
  // every rule above: `com.hyundaipay.hdac` reached the index as a domain from
  // a C2 block that was really listing a mobile application. A real hostname
  // never has a top-level domain as its leftmost label.
  const labels = value.split(".");
  if (
    labels.length > 2 &&
    REVERSE_DNS_HEADS.has(labels[0]) &&
    !COMMON_TLDS.has(labels[labels.length - 1])
  ) {
    return null;
  }
  return value;
}

/**
 * Sites on free hosting platforms, where the subdomain is attacker-chosen and
 * the platform is not.
 *
 * This is the safe subset of "extract domains". A general domain extractor
 * would fire on every vendor, CDN and news site a report mentions; restricting
 * it to platforms that hand anyone a subdomain captures the ones an operation
 * actually stood up. Over the staged corpus this yields Contagious Interview
 * staging infrastructure — vscode-load-config.vercel.app,
 * googlezauthtoken.vercel.app, ip-check-server.vercel.app — alongside persona
 * portfolio sites.
 *
 * Both gates apply: a report also names the legitimate sites these impersonate.
 */
const HOSTED_SITE_HOSTS = [
  "vercel.app",
  "netlify.app",
  "onrender.com",
  "pages.dev",
  // Both added from C2 blocks the domain extractor read: nvidiasdk.fly.dev
  // and oxenhan1.cafe24.com are attacker-chosen subdomains on platforms that
  // hand one to anyone, which is this type and not a registered domain.
  "fly.dev",
  "cafe24.com",
  // ESTsecurity's chai-as-init analysis lists the platform by name in a table
  // of where each version hosted its C2, and the bare name was extracted as a
  // domain. The platform hands anyone a subdomain, so it belongs here.
  "tiiny.site",
  // Railway gives every project a subdomain, and GitLab's year-in-review lists
  // bs-production.up.railway.app among the dropper URLs of one campaign.
  "up.railway.app",
  // InfinityFree hands out subdomains of kesug.com. Frost's Konni thread of
  // 29 September 2026 names fe29jf323.kesug.com as a backdoor's C2 and notes
  // the InfinityFree __test cookie the backdoor has to solve.
  "kesug.com",
];
const HOSTED_SITE_PATTERN = new RegExp(
  String.raw`\b(?:https?:\/\/)?([a-z0-9][a-z0-9-]{1,60}\.(?:` +
    HOSTED_SITE_HOSTS.map((h) => h.replace(/\./g, String.raw`\.`)).join("|") +
    String.raw`))\b`,
  "gi"
);

function normalizeHostedSite(raw) {
  const value = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[.,;:)\]}'"]+$/, "");
  // A bare platform apex is the platform, not somebody's site on it.
  if (HOSTED_SITE_HOSTS.includes(value)) return null;
  const onPlatform = HOSTED_SITE_HOSTS.some((host) => value.endsWith(`.${host}`));
  return onPlatform && /^[a-z0-9][a-z0-9.-]{1,80}$/.test(value) ? value : null;
}

/**
 * Paste and JSON-bin services, where the host is shared and only the full URL
 * names the payload.
 *
 * The opposite case from HOSTED_SITE_HOSTS: there the subdomain is the
 * attacker's and the platform is not, so the host is the indicator. Here the
 * platform is the whole host and the attacker's part is a path, so the host
 * alone would flag every legitimate user of the service and the value has to be
 * the URL. In a report these are the places a loader fetches its next stage
 * from, which is what makes them a payload URL and not a reference.
 *
 * Each entry is an apex and a subdomain of it matches too, so api.npoint.io and
 * api.mocki.io are covered by npoint.io and mocki.io. The list is kept to
 * services a report names as a delivery channel.
 */
const PAYLOAD_URL_HOSTS = [
  // GitLab's year-in-review lists 25 jsonkeeper.com/b/<id> bins as the
  // JavaScript malware droppers of one campaign, and NVISO names JSON Keeper
  // as one of the services Contagious Interview moved to.
  "jsonkeeper.com",
  // Named by NVISO beside JSON Keeper; GitLab lists api.npoint.io URLs.
  "npoint.io",
  // GitLab lists api.mocki.io URLs among the same droppers.
  "mocki.io",
  // The third service NVISO names ("JSONsilo"); its API is on api.jsonsilo.com.
  "jsonsilo.com",
  // The same kind of service: an anonymous bin read back as JSON over HTTP.
  "jsonbin.io",
  // Paste sites are the older form of the same channel, and reports on DPRK
  // loaders have long named pastebin.com/raw/<id> as a second-stage fetch.
  "pastebin.com",
];
const PAYLOAD_URL_PATTERN = new RegExp(
  String.raw`(?<![\w./@-])((?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:` +
    PAYLOAD_URL_HOSTS.map((h) => h.replace(/\./g, String.raw`\.`)).join("|") +
    String.raw`)\/[^\s<>"'\x60)\]]+)`,
  "gi"
);

/**
 * A row of an indicator table whose type column says the entry is a URL or
 * malware, as in GitLab's appendix: "<url> url malware N/A N/A JavaScript
 * malware dropper URL". The type column is what separates the address a row is
 * about from one the row merely mentions, and the caller still requires the row
 * to call itself hostile (isHostileTableRow). This is how a URL on a host not in
 * PAYLOAD_URL_HOSTS, such as chainlink-api-v3.cloud, is taken at all.
 */
const PAYLOAD_URL_ROW_PATTERN = /(\bhttps?:\/\/[^\s<>"'\x60)\]]+)[ \t]+(?:url|malware)\b/gi;

/**
 * Canonical form of a payload URL: lowercase scheme and host, the path and
 * query as written (a bin id is case-sensitive), no fragment, no tracking
 * parameters. A bare host is refused, because a URL with no path names the
 * service and not anything on it.
 */
function normalizePayloadUrl(raw) {
  const text = String(raw)
    .trim()
    .replace(/^h(?:xx|XX)p(s?)/i, "http$1")
    .replace(/[[({]\s*\.\s*[\])}]/g, ".")
    .replace(/[.,;:)\]}'"]+$/, "");
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(text) ? text : "https://" + text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname.includes(".")) return null;
  if (parsed.pathname === "/" && !parsed.search) return null;
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

/**
 * True for a payload URL on a host the extractor must not take: an address
 * (indexed as its own type), a free-hosting subdomain (already the hosted_site
 * type, where the host is the indicator and the path adds nothing), a host on
 * the shared denylist, or one of the report's own hosts.
 */
function isExcludedPayloadUrl(value, opts = {}) {
  const host = hostOf(value);
  if (!host) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (hostMatches(host, HOSTED_SITE_HOSTS)) return true;
  if (hostMatches(host, HOST_DENYLIST)) return true;
  if (hostMatches(host, opts.excludedHosts || [])) return true;
  return CDN_HOST_PATTERNS.some((re) => re.test(host));
}

// ---------------------------------------------------------------------------
// Defanging
// ---------------------------------------------------------------------------

/**
 * Threat-research writing routinely defangs indicators so they aren't
 * clickable — hxxps://evil[.]com, user[at]mail[.]com. Every one of those is a
 * real IOC the raw regexes above would miss entirely, so this runs over the
 * page text before extraction.
 *
 * Only bracketed and parenthesized forms are rewritten. The bare-word form
 * (" dot ", " at ") is deliberately NOT handled: it appears in ordinary prose
 * far more often than in defanged indicators, and rewriting it would corrupt
 * the context snippets this tool exists to quote.
 */
function defang(text) {
  return text
    .replace(/\bh(?:xx|XX)(p|P)(s|S)?\b/g, (m, p, s) => `htt${p}${s || ""}`)
    // Rendered code blocks put a space after the colon: "http: //1.2.3.4:3000/x".
    .replace(/\b(https?):[ \t]+\/\//gi, "$1://")
    .replace(/[[({]\s*\.\s*[\])}]/g, ".")
    .replace(/[[({]\s*dot\s*[\])}]/gi, ".")
    .replace(/[[({]\s*(?:at|@)\s*[\])}]/gi, "@")
    .replace(/[[({]\s*:\s*[\])}]/g, ":")
    .replace(/[[({]\s*\/\/\s*[\])}]/g, "//");
}

// ---------------------------------------------------------------------------
// Cloudflare email obfuscation
// ---------------------------------------------------------------------------

/**
 * Decodes a Cloudflare `data-cfemail="<hex>"` value. Cloudflare's email
 * address obfuscation is an anti-scraper measure that every visitor's own
 * browser undoes via Cloudflare's public JS on a normal page view — this is
 * the same well-documented single-byte XOR decode, not a bypass of any login,
 * paywall, or robots restriction.
 */
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * decodeURIComponent that returns the segment as written when it holds a
 * malformed escape ("foo%zz"), rather than throwing out of whichever
 * normalizer or build step called it.
 */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src",
  "si", "s", "source", "spm", "yclid", "_hsenc", "_hsmi",
]);

/**
 * Lowercases the host, drops the fragment, and strips tracking parameters.
 *
 * The POC this replaced had `parsed._replace(fragment="", query=parsed.query)`
 * — assigning the query back to itself, so nothing was ever stripped and every
 * ?utm_source= variant of one URL became a separate indicator.
 */
function normalizeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw).trim().replace(/[.,;:)\]}'"]+$/, ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

/** Prepends https:// to a bare "host/path" so it can be parsed as a URL. */
function withScheme(raw) {
  const value = String(raw).trim();
  return /^https?:\/\//i.test(value) ? value : "https://" + value;
}

function hostOf(url) {
  try {
    // A source read through the Wayback Machine is still the publisher's
    // page, and the publisher's own addresses on it are still its own. Without
    // this, every archived source resolved to web.archive.org and biz@enki.co.kr
    // came through four ENKI captures as an indicator.
    const archived = String(url).match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/.+)$/i);
    if (archived) return hostOf(archived[1]);
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-type normalizers
// ---------------------------------------------------------------------------

/**
 * Mailbox providers that ignore dots in the local part, so that
 * a.l.l.a.nh.orca0.7@googlemail.com and allanhorca07@gmail.com are one mailbox
 * and must be one record.
 *
 * This is Google's alone, and it has to stay that way. Gmail documents that it
 * ignores dots and everything after a plus, and serves gmail.com and
 * googlemail.com as the same service. Outlook, Hotmail, Proton, Yahoo and the
 * rest treat a dot as an ordinary character: a.smith@outlook.com and
 * asmith@outlook.com are two different people's mailboxes, and stripping dots
 * there would merge two strangers into one indicator. Do not add a host to this
 * set without checking that the provider actually documents the behaviour.
 *
 * It matters here because dotting is deliberate. 775 of the 3,311 Gmail
 * addresses in this index carry a dot in the local part, and among them are
 * a.l.l.a.nh.orca0.7@googlemail.com beside al.la.n.h.o.rca07@gmail.com, and
 * a.yal.a.da.ve7@gmail.com beside ayal.a.d.av.e.7@gmail.com — the same mailbox
 * sprayed with dots so that each posting, each account signup and each report
 * carries a string nothing else matches. Nineteen addresses in the index are two
 * or more records today for exactly that reason, and the plus-tagged ones
 * (edmonddantes000313+1, +2, +32) are the same trick with the other separator.
 */
const DOT_INSENSITIVE_HOSTS = new Set(["gmail.com", "googlemail.com"]);

/** The mailbox an address actually reaches, for the providers that ignore dots. */
function canonicalMailbox(address) {
  const at = address.lastIndexOf("@");
  if (at === -1) return address;
  const local = address.slice(0, at);
  const host = address.slice(at + 1);
  if (!DOT_INSENSITIVE_HOSTS.has(host)) return address;
  const mailbox = local.split("+")[0].replace(/\./g, "");
  if (!mailbox) return address;
  return `${mailbox}@gmail.com`;
}

function normalizeEmail(raw) {
  const value = String(raw).trim().replace(/^[.,;:(\[{'"]+/, "").replace(/[.,;:)\]}'"]+$/, "");
  if (!value) return null;
  const match = value.match(new RegExp(`^${EMAIL_PATTERN.source}$`));
  if (!match) return null;
  // Two dots in a row cannot occur in a real address; they are a publisher's
  // mask. haydenmckenzie.com printed jb.....@gmail.com for an address it
  // withheld, and Gmail's dot-folding turned it into jb@gmail.com.
  if (/\.\./.test(value.split("@")[0])) return null;
  return canonicalMailbox(value.toLowerCase());
}

/**
 * Canonicalizes to https://www.linkedin.com/{in|pub}/{slug}/.
 *
 * Taking only the slug segment and discarding everything after it is what
 * collapses /details/experience, country subdomains (de.linkedin.com) and
 * every tracking suffix onto one value. The slug is lowercased because
 * LinkedIn treats it case-insensitively — the POC preserved case, which
 * silently produced duplicate records for one profile.
 */
function normalizeLinkedin(raw) {
  const normalized = normalizeUrl(withScheme(raw));
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (!parsed.hostname.replace(/^www\./, "").endsWith("linkedin.com")) return null;

  const parts = parsed.pathname.split("/").filter(Boolean).map(safeDecode);
  if (parts.length < 2) return null;
  const kind = parts[0].toLowerCase();
  if (kind !== "in" && kind !== "pub") return null;
  const slug = parts[1].trim().toLowerCase();
  if (!slug) return null;

  return `https://www.linkedin.com/${kind}/${encodeURIComponent(slug)}/`;
}

/**
 * Reserved paths that look like a username but are GitHub's own pages. A URL
 * like github.com/security is a link to GitHub, not to an account.
 *
 * "ghost" is the odd one out: it is a real account, the placeholder GitHub
 * reattributes a deleted user's commits and issues to. A report describing an
 * account that has since been removed links to it, and extracting it publishes
 * GitHub's tombstone as though it were an operator's profile.
 */
const GITHUB_RESERVED = new Set([
  "about", "apps", "blog", "codespaces", "collections", "contact", "customer-stories",
  "enterprise", "events", "explore", "features", "ghost", "issues", "login", "marketplace",
  "new", "notifications", "orgs", "pricing", "pulls", "readme", "search", "security",
  "settings", "signup", "site", "sponsors", "stars", "topics", "trending", "watching",
]);

/**
 * Accounts that reports cite as SOURCES rather than name as indicators.
 *
 * Two ways these get in. A malware write-up links a public indicator feed in
 * its prose — "following the IOC list at github.com/vmware-samples/tau-research"
 * — so seed-host exclusion, which only knows the source's own domain, never
 * sees it. And a PDF puts its whole bibliography in the text layer, so every
 * footnote URL reads as prose to an extractor that has no other way to tell a
 * citation from a finding.
 *
 * Extracting one publishes a security researcher's own account as a DPRK
 * indicator, which is the worst failure this index has: the person is named on
 * a page about state-sponsored fraud for having written about it.
 *
 * Add an account here only after observing it extracted from a real source,
 * never speculatively. This list is a record of specific false positives, and
 * a name added on a hunch silently discards a real operator account that
 * happens to match.
 */
const CITATION_ACCOUNTS = {
  // Kudelski's DPRK ecosystem report cites both for Emotet infrastructure.
  // The espionage batch added four more, every one observed in output rather
  // than guessed at: two vendor organisations a report links in passing
  // (Microsoft's and Ably's), the researcher whose DPRK email-list repository
  // this site already holds under a decision of its own, and `repos`, which
  // is the third segment of an api.github.com path read as an owner.
  github_profile: new Set([
    "vmware-samples",
    "pr0xylife",
    "azure",
    "ably",
    "theravenfile",
    "repos",
    "microsoft",
    "opensourcemalware",
    // The Wayback Machine's banner links ArchiveBot's source on every capture,
    // so it came out of three archived sources in a row.
    "archiveteam",
  ]),
  // MSMT 2025/2 footnotes a Medium post by the researcher Shogun Saski.
  // radiantcapital is the account of a protocol DPRK stole from: the victim,
  // published under the name of the people who robbed it.
  medium_account: new Set(["shosaski", "radiantcapital"]),
};

function isCitationAccount(iocType, handle) {
  const accounts = CITATION_ACCOUNTS[iocType];
  return Boolean(accounts && accounts.has(handle));
}

/**
 * Canonicalizes to https://github.com/{owner}, lowercased.
 *
 * A repo URL is truncated to its owner rather than rejected: github.com/foo/bar
 * is evidence that account `foo` exists and was named in the report, which is
 * exactly the indicator being tracked. The POC required a single path segment
 * and threw away every repo link it saw.
 */
function normalizeGithub(raw) {
  const normalized = normalizeUrl(withScheme(raw));
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.hostname.replace(/^www\./, "") !== "github.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean).map(safeDecode);
  if (parts.length === 0) return null;
  const username = parts[0].trim().toLowerCase();
  if (!username || GITHUB_RESERVED.has(username)) return null;
  if (isCitationAccount("github_profile", username)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(username)) return null;

  return `https://github.com/${username}`;
}

/**
 * Handle-on-a-platform accounts.
 * ==========================================================================
 * A DPRK IT-worker persona is not one account, it is a spread of them: the
 * GitHub and the LinkedIn are the two this repo extracted first, but the same
 * reports name the Telegram the operator negotiates on, the freelancing profile
 * they bid from, and the Medium and dev.to accounts that pad out a fake
 * portfolio. Each of those is the same shape of thing — a handle under a fixed
 * path on a fixed host — so one table describes them all rather than nine
 * near-identical regex/normalizer pairs.
 *
 * Every entry here is a platform seen carrying a persona account somewhere in
 * this corpus. Do not add one speculatively: an extractor that fires on a
 * platform no operator uses will only ever produce false positives from a
 * report's own boilerplate.
 *
 * `reserved` is what keeps a platform's own routes out. t.me/joinchat is an
 * invite link, x.com/intent is a share button, dev.to/t is a tag index — all of
 * them match the handle shape and none of them is an account.
 *
 * `auto_extract: false` means the type is real but the scraper must not fire on
 * it — see the note on x_account. Such a type is still reachable by hand, from
 * a curated file where a person attributed each value individually.
 */
const PLATFORM_ACCOUNTS = [
  {
    ioc_type: "telegram_account",
    hosts: ["t.me", "telegram.me", "telegram.dog"],
    canonical: "t.me",
    prefix: "",
    // Telegram usernames are 5-32 characters and must start with a letter, so a
    // run of digits is never one. The looser /^[a-z0-9_]{4,32}$/ this replaced
    // accepted a numeric peer ID and turned it into t.me/<id>, a URL that does
    // not resolve to the account it names -- a wrong indicator rather than a
    // missing one. Researchers do publish peer IDs, and they need their own type
    // rather than being squeezed into this one.
    handle: /^[a-z][a-z0-9_]{4,31}$/,
    reserved: new Set([
      "joinchat", "s", "share", "addstickers", "addemoji", "addtheme",
      "proxy", "socks", "iv", "setlanguage", "c", "login",
      // Telegram's own bot for creating bots; READMEs link it in setup steps.
      "botfather",
    ]),
  },
  {
    ioc_type: "x_account",
    hosts: ["x.com", "twitter.com"],
    canonical: "x.com",
    prefix: "",
    // NOT auto-extracted, on evidence. Run against the 27 staged source texts
    // this pattern produced 97 handles, and roughly a quarter were the
    // reporting side rather than the reported: the researchers who wrote the
    // articles (tayvano_, zachxbt, pcaversaccio, browsercookies), news accounts
    // (nknewsorg) and the legitimate projects that were targeted. A threat
    // report names X handles on both sides of its own story and nothing in the
    // surrounding prose separates them, so publishing these automatically would
    // put uninvolved researchers into an index of DPRK indicators. The type
    // stays for curated use, where a person attributes each handle.
    auto_extract: false,
    // X caps handles at 15 characters, which is what separates an account path
    // from the platform's many other one-segment routes.
    handle: /^[a-z0-9_]{1,15}$/,
    reserved: new Set([
      "home", "explore", "search", "i", "intent", "share", "hashtag", "compose",
      "messages", "notifications", "settings", "login", "signup", "logout",
      "about", "tos", "privacy", "download", "status", "help", "account",
    ]),
  },
  {
    ioc_type: "medium_account",
    hosts: ["medium.com"],
    canonical: "medium.com",
    prefix: "@",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    // GitLab, added 2026-09-12. Searching the handles this index already holds
    // for a persona turns up GitLab accounts under the same login more often
    // than anything else, and a GitLab profile states a display name and a
    // member-since date that the matching GitHub account does not — evgpan is
    // "Евгений Панов (Evgeny Panov)" there, climaxstar is "Zenith Taylor".
    ioc_type: "gitlab_account",
    hosts: ["gitlab.com"],
    canonical: "gitlab.com",
    prefix: "",
    handle: /^[a-z0-9][a-z0-9._-]{1,254}$/,
    reserved: new Set([
      "explore", "help", "users", "groups", "projects", "dashboard", "search",
      "admin", "profile", "public", "snippets", "-", "api", "sign_in", "sign_up",
    ]),
  },
  {
    ioc_type: "devto_account",
    hosts: ["dev.to"],
    canonical: "dev.to",
    prefix: "",
    // dev.to allows a hyphen in a username and this pattern did not, so a real
    // account like superstar-lucas failed to normalize and stopped the build.
    handle: /^[a-z0-9_-]{2,64}$/,
    reserved: new Set([
      "t", "tags", "enter", "signout", "new", "search", "about", "privacy",
      "terms", "contact", "pod", "videos", "listings", "readinglist",
      "dashboard", "settings", "notifications",
    ]),
  },
  {
    ioc_type: "freelancer_account",
    // Freelancer serves the same profiles on country sites.
    hosts: [
      "freelancer.com", "freelancer.hk", "freelancer.co.ke", "freelancer.in",
      "freelancer.co.uk", "freelancer.ca", "freelancer.com.au", "freelancer.ph",
      "freelancer.pk", "freelancer.sg", "freelancer.my", "freelancer.co.za",
    ],
    canonical: "freelancer.com",
    prefix: "u/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "codesandbox_account",
    hosts: ["codesandbox.io"],
    canonical: "codesandbox.io",
    prefix: "u/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    // The three below were added 2026-09-17, extending the handle pivot that
    // added GitLab above. Each answers a plain public API about a username and
    // distinguishes a real account from an absent one, which is the bar: npm,
    // Codeberg, Reddit and SourceForge all refused the pass and are recorded
    // nowhere, because being blocked and finding nothing are different claims.
    //
    // Docker Hub is the most useful of the three. It states a registration date
    // the matching GitHub account does not, and its full-name field is free
    // text that two of these operators filled with their own email address.
    ioc_type: "dockerhub_account",
    hosts: ["hub.docker.com", "docker.com"],
    canonical: "hub.docker.com",
    prefix: "u/",
    // Docker Hub allows only lowercase letters and digits, four or more.
    handle: /^[a-z0-9]{4,30}$/,
    reserved: new Set([
      "_", "r", "u", "explore", "search", "settings", "orgs", "repository",
      "support", "pricing", "features", "products", "login", "signup",
    ]),
  },
  {
    // Keybase states a registration date, and its proofs are signed claims
    // posted to the other account rather than a name typed into a field — the
    // one platform in this pass that evidences control of two accounts rather
    // than merely presenting a name.
    ioc_type: "keybase_account",
    hosts: ["keybase.io"],
    canonical: "keybase.io",
    prefix: "",
    handle: /^[a-z0-9_]{2,16}$/,
    reserved: new Set([
      "docs", "download", "blog", "about", "jobs", "press", "security",
      "privacypolicy", "terms", "teams", "_", "encrypt", "decrypt", "sign",
    ]),
  },
  {
    ioc_type: "huggingface_account",
    hosts: ["huggingface.co"],
    canonical: "huggingface.co",
    prefix: "",
    handle: /^[a-z0-9][a-z0-9._-]{1,63}$/,
    reserved: new Set([
      "models", "datasets", "spaces", "docs", "blog", "pricing", "join",
      "login", "settings", "search", "organizations", "papers", "tasks",
      "chat", "posts", "collections", "new", "api",
    ]),
  },
  {
    ioc_type: "trello_account",
    hosts: ["trello.com"],
    canonical: "trello.com",
    prefix: "u/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "quora_account",
    hosts: ["quora.com"],
    canonical: "quora.com",
    prefix: "profile/",
    handle: /^[a-z0-9._-]{2,80}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "odnoklassniki_account",
    hosts: ["ok.ru", "odnoklassniki.ru"],
    canonical: "ok.ru",
    prefix: "profile/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    // Added 2026-09-18. freelancermap serves a profile's employment history
    // as JSON in the page, with the profile's creation date and last login,
    // which is how a second, different history under a persona's name was
    // read beside its LinkedIn one. The .de and .com hosts serve the same
    // profiles.
    ioc_type: "freelancermap_account",
    hosts: ["freelancermap.com", "freelancermap.de"],
    canonical: "freelancermap.com",
    prefix: "profile/",
    handle: /^[a-z0-9._-]{2,80}$/,
    reserved: new Set(["login", "register", "pricing", "blog", "contact", "search", "projects"]),
  },
  {
    ioc_type: "fiverr_account",
    hosts: ["fiverr.com"],
    canonical: "fiverr.com",
    prefix: "",
    handle: /^[a-z0-9_]{2,64}$/,
    reserved: new Set([
      "categories", "search", "login", "join", "pro", "explore", "business",
      "support", "terms_of_service", "privacy_policy", "s", "users", "cp",
    ]),
  },
  {
    // Added 2026-09-24 with the freelance and profile hosts below, which DPRK
    // IT-worker reports list beside a persona's GitHub and mail. Upwork profile
    // ids are either a vanity name or a ~01-prefixed hash.
    ioc_type: "upwork_account",
    hosts: ["upwork.com"],
    canonical: "upwork.com",
    prefix: "freelancers/",
    handle: /^~?[a-z0-9._-]{2,64}$/,
    reserved: new Set(["search", "agency"]),
  },
  {
    // LaborX addresses a freelancer by a numeric id only.
    ioc_type: "laborx_account",
    hosts: ["laborx.com"],
    canonical: "laborx.com",
    prefix: "freelancers/users/",
    handle: /^id[0-9]{1,12}$/,
    reserved: new Set([]),
  },
  {
    // Klimbup, a Latin American talent platform; a Famous Chollima persona
    // Bitso's Quetzal team interviewed listed a profile there (2026-10-01).
    ioc_type: "klimbup_account",
    hosts: ["klimbup.com"],
    canonical: "klimbup.com",
    prefix: "perfiles/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "peerlist_account",
    hosts: ["peerlist.io"],
    canonical: "peerlist.io",
    prefix: "",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set(["login", "signup", "register", "search", "about", "pricing", "blog", "help", "jobs", "jobs", "scroll", "network", "projects", "company"]),
  },
  {
    ioc_type: "xing_account",
    hosts: ["xing.com"],
    canonical: "xing.com",
    prefix: "profile/",
    handle: /^[a-z0-9._-]{2,80}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "torre_account",
    hosts: ["torre.ai", "torre.co"],
    canonical: "torre.ai",
    prefix: "",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set(["login", "signup", "register", "search", "about", "pricing", "blog", "help", "jobs", "search", "jobs", "post", "ai"]),
  },
  {
    ioc_type: "himalayas_account",
    hosts: ["himalayas.app"],
    canonical: "himalayas.app",
    prefix: "@",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "producthunt_account",
    hosts: ["producthunt.com"],
    canonical: "producthunt.com",
    prefix: "@",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "f6s_account",
    hosts: ["f6s.com"],
    canonical: "f6s.com",
    prefix: "member/",
    handle: /^[a-z0-9._-]{2,80}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "entre_account",
    hosts: ["joinentre.com"],
    canonical: "joinentre.com",
    prefix: "profile/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "linktree_account",
    hosts: ["linktr.ee"],
    canonical: "linktr.ee",
    prefix: "",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set(["login", "signup", "register", "search", "about", "pricing", "blog", "help", "jobs", "s", "admin", "marketplace", "features", "templates"]),
  },
  {
    ioc_type: "remoteok_account",
    hosts: ["remoteok.com", "remoteok.io"],
    canonical: "remoteok.com",
    prefix: "@",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "remotehub_account",
    hosts: ["remotehub.com"],
    canonical: "remotehub.com",
    prefix: "",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set(["login", "signup", "jobs", "companies", "blog", "about", "pricing", "search", "remote-jobs"]),
  },
  {
    // Balkan Freelance puts a language segment in front of the account path;
    // the employer profile is the form reports have named so far.
    ioc_type: "balkanfreelance_account",
    hosts: ["balkanfreelance.com"],
    canonical: "balkanfreelance.com",
    prefix: "en/employer/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    // Wantedly, a Japanese job site, serves profiles on country subdomains (sg., jp.).
    ioc_type: "wantedly_account",
    hosts: ["wantedly.com"],
    canonical: "wantedly.com",
    prefix: "id/",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    // Hashnode, a developer blog host, puts the profile under /@handle.
    ioc_type: "hashnode_account",
    hosts: ["hashnode.com"],
    canonical: "hashnode.com",
    prefix: "@",
    handle: /^[a-z0-9_-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "calendly_account",
    hosts: ["calendly.com"],
    canonical: "calendly.com",
    prefix: "",
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set(["login", "signup", "register", "search", "about", "pricing", "blog", "help", "jobs", "app", "integrations", "resources", "features", "event_types", "d"]),
  },
  // The four below were added for contacts read off persona portfolio sites.
  // None is auto-extracted: a report's own footer links to its publisher's
  // Instagram and Facebook pages far more often than it names an operator's.
  {
    ioc_type: "instagram_account",
    hosts: ["instagram.com"],
    canonical: "instagram.com",
    prefix: "",
    auto_extract: false,
    handle: /^[a-z0-9._]{1,30}$/,
    reserved: new Set(["p", "reel", "reels", "explore", "accounts", "stories", "direct", "tv", "about", "legal", "developer"]),
  },
  {
    // A Facebook profile is either a vanity path or profile.php?id=<number>;
    // `id_path` names the page whose query parameter carries the account.
    ioc_type: "facebook_account",
    hosts: ["facebook.com", "fb.com", "m.facebook.com"],
    canonical: "facebook.com",
    prefix: "",
    auto_extract: false,
    id_path: "profile.php",
    id_param: "id",
    handle: /^[a-z0-9.]{5,50}$/,
    reserved: new Set(["sharer", "sharer.php", "share", "dialog", "groups", "pages", "events", "watch", "login", "help", "policies", "privacy", "marketplace", "gaming", "hashtag", "people", "photo.php", "story.php", "permalink.php", "plugins", "tr"]),
  },
  {
    // Stack Overflow keys a profile on its number; the name after it is a slug
    // the site rewrites to whatever the display name currently is.
    ioc_type: "stackoverflow_account",
    hosts: ["stackoverflow.com"],
    canonical: "stackoverflow.com",
    prefix: "users/",
    auto_extract: false,
    handle: /^\d{1,10}$/,
    reserved: new Set([]),
  },
  // Five job and hackathon boards, added for the Jackson Mori profiles in
  // Heiner García's post of 2 August 2025. Curated only, like the rest here.
  {
    ioc_type: "useme_account",
    hosts: ["useme.com"],
    canonical: "useme.com",
    prefix: "en/roles/contractor/",
    auto_extract: false,
    // The profile path is <slug>,<number>; the number is the account.
    handle: /^[a-z0-9-]{2,64},\d{1,10}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "cryptojobslist_account",
    hosts: ["cryptojobslist.com"],
    canonical: "cryptojobslist.com",
    prefix: "@",
    auto_extract: false,
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "web3career_account",
    hosts: ["web3.career"],
    canonical: "web3.career",
    prefix: "@",
    auto_extract: false,
    handle: /^[a-z0-9._-]{1,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "cryptojobs_account",
    hosts: ["crypto.jobs"],
    canonical: "crypto.jobs",
    prefix: "talent/profile/",
    auto_extract: false,
    handle: /^[a-z0-9-]{2,80}$/,
    reserved: new Set([]),
  },
  {
    // 9am.works, a talent marketplace; the profile is app.9am.works/talent/<slug>.
    // Added for CVs in the pipu.cc set that carry their talent page.
    ioc_type: "nineamworks_account",
    hosts: ["9am.works"],
    canonical: "app.9am.works",
    prefix: "talent/",
    auto_extract: false,
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set([]),
  },
  {
    ioc_type: "devpost_account",
    hosts: ["devpost.com"],
    canonical: "devpost.com",
    prefix: "",
    auto_extract: false,
    handle: /^[a-z0-9._-]{2,64}$/,
    reserved: new Set(["software", "hackathons", "settings", "portfolio", "users", "about", "help", "api", "search"]),
  },
  {
    // A YouTube channel handle, youtube.com/@handle; added for justshiftjk's
    // channel in Ketman's GitHub-organisations report.
    ioc_type: "youtube_account",
    hosts: ["youtube.com", "m.youtube.com"],
    canonical: "youtube.com",
    prefix: "@",
    auto_extract: false,
    handle: /^[a-z0-9._-]{3,30}$/,
    reserved: new Set([]),
  },
  {
    // discord.com/users/ resolves a numeric user id. Persona sites also put a
    // bare username there, which Discord does not resolve but which is still
    // the handle the site advertises, so both shapes are kept.
    ioc_type: "discord_account",
    hosts: ["discord.com", "discordapp.com"],
    canonical: "discord.com",
    prefix: "users/",
    auto_extract: false,
    handle: /^(?:\d{15,20}|[a-z0-9._]{2,32})$/,
    reserved: new Set([]),
  },
];

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** The prose pattern for one platform, built from its host list and path prefix. */
function platformAccountPattern(spec) {
  const hosts = spec.hosts.map((host) => host.replace(RE_ESCAPE, "\\$&")).join("|");
  const prefix = spec.prefix.replace(RE_ESCAPE, "\\$&");
  return new RegExp(
    String.raw`\b(?:https?:\/\/)?(?:www\.)?(?:` + hosts + String.raw`)\/` +
      prefix + String.raw`[A-Za-z0-9._-]+`,
    "gi"
  );
}

/**
 * The normalizer for one platform: same handle always produces the same URL,
 * so two reports writing it differently collapse to one indicator.
 */
function normalizePlatformAccount(spec) {
  return function (raw) {
    const normalized = normalizeUrl(withScheme(raw));
    if (!normalized) return null;

    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      return null;
    }
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!spec.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return null;
    }

    let segments = parsed.pathname.split("/").filter(Boolean).map(safeDecode);
    if (spec.id_path && segments.length === 1 && segments[0].toLowerCase() === spec.id_path) {
      const id = parsed.searchParams.get(spec.id_param) || "";
      return /^\d{5,20}$/.test(id) ? `https://${spec.canonical}/${spec.id_path}?${spec.id_param}=${id}` : null;
    }
    // facebook.com/people/<display name>/<id> is the same account as
    // profile.php?id=<id>; the name part is whatever the page is called today.
    if (spec.id_path && segments.length === 3 && segments[0].toLowerCase() === "people" && /^\d{5,20}$/.test(segments[2])) {
      return `https://${spec.canonical}/${spec.id_path}?${spec.id_param}=${segments[2]}`;
    }
    // Platforms that nest accounts under fixed segments (freelancer /u/,
    // quora /profile/, laborx /freelancers/users/) must actually carry them; a
    // bare root URL is not one.
    const gate = spec.prefix.endsWith("/") ? spec.prefix.slice(0, -1).toLowerCase().split("/") : null;
    if (gate) {
      if (segments.length < gate.length) return null;
      if (gate.some((part, i) => segments[i].toLowerCase() !== part)) return null;
      segments = segments.slice(gate.length);
    }
    if (!segments.length) return null;

    let handle = segments[0].trim();
    if (spec.prefix === "@") {
      if (!handle.startsWith("@")) return null;
      handle = handle.slice(1);
    }
    handle = handle.toLowerCase();
    if (!handle || spec.reserved.has(handle)) return null;
    if (isCitationAccount(spec.ioc_type, handle)) return null;
    if (!spec.handle.test(handle)) return null;

    const shown = spec.prefix === "@" ? `@${handle}` : `${spec.prefix}${handle}`;
    return `https://${spec.canonical}/${shown}`;
  };
}

/**
 * Reserved, private and documentation ranges. A page saying "connect to
 * 192.168.1.1" or showing a screenshot of 10.0.0.5 is not publishing an IOC,
 * and the POC had no filtering here at all.
 */
function isReservedIpv4(value) {
  const o = value.split(".").map(Number);
  if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  // Reports write a range as 188.43.253.0/24 and the address pattern takes the
  // address without the prefix, so three network addresses were published as
  // though they were C2 hosts. A final octet of zero is the network address of
  // any /24 and is not something a backdoor connects to. It costs the rare
  // genuine .0 host inside a wider prefix, which is the right trade for an
  // index that would otherwise name a whole range as one machine.
  if (o[3] === 0) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  const prefix = o.slice(0, 3).join(".");
  return ["192.0.0", "192.0.2", "192.88.99", "198.51.100", "203.0.113"].includes(prefix);
}

/**
 * npm names are lowercase by registry rule.
 *
 * A trailing version specifier (`left-pad@1.3.0`) is dropped by default, so a
 * report naming three releases of one package in its prose produces one
 * indicator rather than three.
 *
 * `keepVersion` inverts that, and the curated paths pass it. CONTENT_GUIDE.md
 * requires a bulk package entry to be version-pinned for a reason that matters:
 * where a legitimate package was compromised, the bare name identifies the
 * VICTIM and only the pin identifies the malicious release. 45 pinned entries
 * are published today, and until this argument existed, wiring npm_package
 * into any curated normalizer would have quietly stripped every one of them
 * back to the innocent project's name.
 */
// Words an IOC section's heading puts beside a package list ("# Malicious npm
// Packages"), which the extractor read as a package named "malicious" in
// eleven reports. A bare name equal to one of them is a heading, not a package.
const NPM_HEADING_WORDS = new Set(["malicious", "package", "packages", "npm", "indicators", "iocs", "name", "version", "versions"]);

function normalizeNpmPackage(raw, opts = {}) {
  const value = String(raw).trim().replace(/[.,;:)\]}'"]+$/, "").toLowerCase();
  const match = value.match(/^(@[^/]+\/[^@]+|[^@]+)(@.*)?$/);
  if (!match) return null;
  const name = match[1];
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)) return null;
  if (NPM_HEADING_WORDS.has(name)) return null;
  if (name.length > 214) return null;
  const version = opts.keepVersion && match[2] ? match[2] : "";
  return name + version;
}

function normalizeChromeExtension(raw) {
  const value = String(raw).trim().toLowerCase();
  return /^[a-p]{32}$/.test(value) ? value : null;
}

/**
 * Guards the bare-id pattern above: a 32-character a-p run only counts as an
 * extension id when the text around it is actually discussing an extension.
 */
function looksLikeExtensionContext(text, index, window = 220) {
  const around = text.slice(Math.max(0, index - window), index + window).toLowerCase();
  return /extension|webstore|web store|chrome|browser add-?on/.test(around);
}

/**
 * True when the surrounding text is describing the artifact as a VICTIM rather
 * than as an indicator — the wallet the malware steals from, the legitimate
 * package it impersonates, the extension it targets.
 *
 * This distinction is invisible to a pattern match and getting it wrong is the
 * worst failure this tool can have: listing MetaMask's extension id as a "DPRK
 * indicator" defames a legitimate project. Real cases this catches are
 * socket.dev's "Targeted wallet extension IDs:" list (Keplr, MetaMask, Phantom)
 * and ketman's "(Potentially vulnerable Chrome Extension)" annotation.
 *
 * Applied to package and extension indicators only. Email addresses and
 * accounts do not have this ambiguity — a report naming one is reporting on it.
 */
/**
 * True when the surrounding text positively states the artifact is hostile.
 *
 * Package and extension indicators require this, rather than merely failing a
 * victim check. A negative filter is the wrong shape for a long appendix list:
 * the heading that says "targeted wallet extension IDs" sits far outside any
 * reasonable window from the twentieth id beneath it, so ids near the bottom
 * silently pass. Requiring a positive statement fails closed instead — the
 * index under-reports rather than accusing a legitimate project.
 *
 * The curated rulesets are the right home for these types; see
 * recordsFromRuleset in src/_data/iocIndex.js.
 */
function looksLikeMaliciousContext(text, index, window = 260) {
  const around = text.slice(Math.max(0, index - window), index + window).toLowerCase();
  return /malicious|malware|compromis|trojan|typosquat|backdoor|infostealer|credential.theft|threat actor|attacker|dprk|north korea/.test(
    around
  ) || looksLikeSeizureContext(around);
}

/**
 * The same positive statement, made in the vocabulary of a court filing.
 *
 * A forfeiture complaint is the strongest attribution this index ever gets, and
 * the gate above rejected almost all of one. DOJ's complaint in the IT-worker
 * money-laundering case lists 41 wallet addresses and describes each as seized
 * under a numbered warrant; it never says "malicious" or "attacker", because a
 * pleading says "the defendant property" and "subject to forfeiture" instead.
 * One address of the 41 passed, and only because unrelated wording happened to
 * fall inside its window.
 *
 * Naming an address as seized property in a forfeiture action asserts that it
 * is the subject of the case, which is exactly what the gate is asking. The
 * victim check still runs alongside this, so property described as taken *from*
 * someone is still excluded.
 */
function looksLikeSeizureContext(around) {
  // `froze`/`frozen` covers the other half of the same complaint. Where an
  // address was not seized under a warrant, the pleading says the stablecoin in
  // it "was voluntarily frozen by Tether on or about" a date -- an issuer
  // freezing the proceeds at law enforcement's request. That phrasing carries
  // 26 of the 41 addresses, in enumerated runs long enough that the nearest
  // "seized" falls outside any sane window.
  return /seiz(?:e|ed|ing|ure)|forfeit|froz(?:e|en)|indict(?:ment|ed)|money launder|sanctions evasion|defendant propert/.test(
    around
  );
}

/**
 * True when a GitHub URL at this position is a package manifest's link to its
 * upstream project rather than an account the report is naming.
 *
 * npm renders a package's `bugs.url` as `<repo>/issues` and its `homepage` as
 * `<repo>#readme`, and both get copied into an IOC table when a report dumps a
 * malicious release's metadata. In an impersonation the manifest points at the
 * package being impersonated, so those two forms name the LEGITIMATE project.
 *
 * kmsec's released-package feed put `github.com/mcollina/thread-stream/issues`
 * and `#readme` in a table of malicious releases, one line away from the
 * attacker addresses. Matteo Collina maintains thread-stream and pino; the
 * malicious package borrowed his manifest. Nothing in the surrounding text says
 * "victim" -- an IOC table has no prose -- so the victim gate could not see it,
 * and the account would have been published as a DPRK indicator.
 */
function isPackageManifestLink(text, index) {
  // `/issues` must END the path. npm's bugs field renders exactly
  // `<repo>/issues`, whereas `<repo>/issues/42` links one thread, which on an
  // attacker's own repository is a legitimate thing for a report to cite.
  return /^(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/issues(?![\/\w])|\/?#readme\b)/i.test(
    text.slice(index, index + 200)
  );
}

function looksLikeVictimContext(text, index, window = 260) {
  const around = text.slice(Math.max(0, index - window), index + window).toLowerCase();
  return /target(?:s|ed|ing)?\b|victim|legitimate|vulnerable|impersonat|steals? from|spoof|masquerad|popular wallet|well-known|taken over|takeover|hijack|compromised account|account that|belongs to|owned by|maintainer/.test(
    around
  );
}

/**
 * Headings that mark a page's chrome rather than its reporting — navigation,
 * author bios, footers. An indicator whose nearest heading is one of these was
 * not found in the article's content, so it is not an indicator the article
 * reported. This is what catches a publisher's own contact address and the
 * author's own GitHub link in their byline.
 *
 * A heading that is itself a bare URL is treated the same way: real section
 * headings are prose, and a URL as a "heading" means the extractor landed in a
 * link block rather than a section.
 */
function isChromeSection(label) {
  if (!label) return false;
  if (/^https?:\/\//i.test(label.trim())) return true;
  // Several of these were bare substrings and matched inside ordinary words,
  // which silently discarded whole indicator sections. "follow" matched every
  // heading beginning "The following individuals/indicators/domains...", the
  // standard way an advisory or a sanctions designation introduces its list —
  // OFAC's SDN pages lost their entire contents to it. "cookie" would have
  // taken a "Stolen cookies" section, and "terms" any heading using the word
  // in its ordinary sense. Each generic word is now anchored to the heading,
  // or paired with the word that makes it site chrome rather than prose.
  // A bibliography is the other end of the same problem as an author bio: every
  // URL in it belongs to somebody the article is citing, not to anybody it is
  // reporting on. Nocturnal Knight's PolinRider post closes with "References &
  // Further Reading", and the run took two indicators out of it -- a GitHub
  // account belonging to the maintainer of a Unicode regex library the article
  // cites as background, and the IP behind the URL of the author's own earlier
  // post. Publishing either would have named an uninvolved developer and the
  // publisher itself.
  const REFERENCE_LIST = /^references?\b|references? (and|&) further reading|further reading|bibliography|works cited|^citations?$|^sources (and|&) references$/i;
  if (REFERENCE_LIST.test(label.trim())) return true;
  return /table of contents|^contents$|^contact\b|contact us|get in touch|^follow\b|follow us|subscribe|newsletter|share this|related (posts|reading|articles)|about the author|author bio|^comments$|navigation|^menu$|cookie (policy|notice|settings)|^cookies?$|privacy policy|^privacy$|^terms\b|terms of (service|use)|sign ?up|log ?in|search$/i.test(
    label
  );
}

/**
 * Headings that mark a list of the people and projects HARMED by the activity
 * being reported, rather than the accounts conducting it.
 *
 * Account-takeover and open-source-bounty-fraud writeups routinely publish
 * both in the same appendix. Extracting from a section titled "List of
 * Affected Projects and Developers" names legitimate maintainers as DPRK
 * indicators — the most damaging mistake this tool can make.
 *
 * Supply-chain writeups add "Infected repositories" and "Poisoned packages":
 * SafeDep's PolinRider report tabulates thirty GitHub owners whose projects
 * carried the implant. "Infected" alone is not enough, because "Infection
 * chain" and "Initial infection method" head the actor's own infrastructure.
 */
function isVictimSection(label) {
  if (!label) return false;
  return /affected|victim|impacted|taken over|takeover|compromised|hijack|targeted|breached|(infected|poisoned) (repositor|project|package|developer|maintainer|account|organi[sz]ation)/i.test(
    label
  );
}

/**
 * The public DNS resolvers. None of them is ever an indicator.
 *
 * 1.1.1.1 and 8.8.8.8 were both in the published index, and both arrived the
 * same way: a report pasting the terminal session it used to check whether a C2
 * domain still resolved ("nslookup pbxsources.com / Server: 1.1.1.1"), and a
 * detection write-up describing malware pinging Google's resolver to test
 * connectivity. The address is in the report, and the report is about DPRK
 * activity, so extraction is working exactly as written — the value is simply
 * the analyst's own resolver or a liveness check, and listing it as DPRK
 * infrastructure points a defender at Cloudflare.
 *
 * Both are also version-shaped and would be caught below; the set is kept
 * because the ones that are not — Quad9's second address, OpenDNS, Yandex —
 * arrive in exactly the same sentences.
 */
const PUBLIC_RESOLVER_IPS = new Set([
  "1.1.1.1", "1.0.0.1", "1.1.1.2", "1.1.1.3",
  "8.8.8.8", "8.8.4.4",
  "9.9.9.9", "9.9.9.10", "9.9.9.11", "149.112.112.112", "149.112.112.11",
  "208.67.222.222", "208.67.220.220", "208.67.222.123",
  "4.2.2.1", "4.2.2.2", "4.2.2.3", "4.2.2.4",
  "64.6.64.6", "64.6.65.6",
  "77.88.8.8", "77.88.8.1",
  "94.140.14.14", "94.140.15.15",
  "76.76.2.0", "76.76.10.0", "76.76.19.19",
  "185.228.168.9", "185.228.169.9",
  "156.154.70.1", "156.154.71.1",
  "45.90.28.0", "45.90.30.0",
  "8.26.56.26", "8.20.247.20",
]);

/**
 * CDN edge ranges, where an address identifies the content-delivery network in
 * front of a site rather than the machine behind it.
 *
 * A report that resolves a lure domain and prints the answer is printing
 * Cloudflare's anycast edge: 94 of the addresses in this index sit in
 * Cloudflare's own published ranges, which means 94 records whose subject is
 * Cloudflare. Blocking one blocks a sizeable fraction of the web, pivoting on one
 * returns every other site behind the same edge, and nothing about it is DPRK
 * infrastructure. Akamai's and Fastly's edges are the same thing.
 *
 * Cloud compute is deliberately NOT here. Operators rent from AWS, Azure, Google
 * and Linode, and an address there is a machine somebody chose — including 41 AWS
 * and 22 Linode addresses in this index that reports name as C2 hosts. This list
 * is only for networks that proxy other people's sites.
 *
 * Cloudflare publishes the authoritative list at https://www.cloudflare.com/ips/
 * and it changes rarely; refresh it if a range is added.
 */
const CDN_EDGE_RANGES = [
  // Cloudflare
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  // Akamai edge
  "23.32.0.0/11", "23.64.0.0/14", "104.64.0.0/10", "184.24.0.0/13",
  // Fastly
  "151.101.0.0/16", "199.232.0.0/16",
];

function ipv4ToInt(value) {
  return value.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
}

function isInIpv4Range(value, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((ipv4ToInt(value) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

/**
 * A dotted quad that is a version number, a numbered section or a hex dump read
 * four bytes at a time, rather than an address.
 *
 * This is the single largest source of false IP indicators in the corpus, and an
 * earlier audit removed nine of them by hand — two Flash versions, two AutoIt
 * versions, a KMPlayer version, a MagicLine4NX version range, two lure builds and
 * an X.509 OID — noting that the pattern recurs across sources and belongs here
 * as a rule. It does: 34 of the published addresses are of this kind, including
 * the OID prefix 1.3.6.1, the section numbers of a Korean monthly threat report
 * ("4.3.3.1 탐지 정보"), a column of EDRKillShifter build numbers, and four-digit
 * groups lifted out of a UTF-16 hex dump.
 *
 * The shape alone decides it, because the context does not: that report's section
 * numbers sit in a paragraph about IPv4 addresses, and the version column sits in
 * a table of malware infrastructure. What no real address in this corpus does is
 * open with a single digit and keep every remaining octet under 32 — the genuine
 * low-first-octet addresses here are Korean (1.223.129.234, 1.234.41.14) and AWS
 * (3.137.98.129), and every one of them carries an octet well above 31. The cost
 * is the occasional real address inside 1-9.0-31.0-31.0-31, which is a narrow
 * slice of the space and the right trade against 34 published non-addresses.
 */
function isVersionShapedIpv4(value) {
  const o = value.split(".").map(Number);
  return o[0] <= 9 && o[1] <= 31 && o[2] <= 31 && o[3] <= 31;
}

function normalizeIpv4(raw) {
  const value = String(raw).trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return null;
  // A leading zero in an octet is not a dotted quad. "03.149.98.247" was read off
  // a line-wrapped table and published as an address; some resolvers would read
  // it as octal, none of them as the address the report meant.
  if (/(^|\.)0\d/.test(value)) return null;
  if (isReservedIpv4(value)) return null;
  if (PUBLIC_RESOLVER_IPS.has(value)) return null;
  if (isVersionShapedIpv4(value)) return null;
  if (CDN_EDGE_RANGES.some((cidr) => isInIpv4Range(value, cidr))) return null;
  return value;
}

/**
 * Telephone numbers, canonicalized to E.164: a leading "+", the country code,
 * then the digits, and no separators at all.
 *
 * A telephone number is the one identifier in this index whose written form
 * carries no information. A CV prints "(832) 706-3757", a researcher's chart
 * prints "+1 832 706 3757", a registry table prints "18327063757", and all
 * three are the same line rented from the same carrier — but the record id is a
 * hash of the value, so carrying the source's punctuation through filed them as
 * three separate indicators with a third of the citations each. That had already
 * happened: 419-746-0450 sat in the index twice, once as "+1-419-746-0450" and
 * once as "14197460450", and Ming Cheng's number was one record from a registry
 * and a second from the post that documented the same operator.
 *
 * Separators are therefore dropped rather than tidied, because any choice of
 * separator is a choice the next source will make differently.
 *
 * A value that already states its country code is trusted on it and only has
 * its punctuation removed. A value that does not is assumed to be NANP, which
 * every bare ten-digit number in this corpus is — they come from US resumes
 * that print a US number beside a US city — and anything else is rejected so
 * that dossiers.js stops the build rather than publishing a number whose
 * country is this site's guess.
 *
 * Length is checked only against E.164's own 15-digit ceiling, not against what
 * each country actually assigns. One transcribed number, "+1753362648", is nine
 * subscriber digits where NANP wants ten, and it is what the researcher's chart
 * published; rejecting it would stop the build over somebody else's typo, and
 * silently repairing it would invent a number nobody reported.
 */
function normalizePhone(raw) {
  const value = String(raw).trim();
  const digits = value.replace(/\D/g, "");
  if (!digits || digits.length > 15 || /[^\d\s()+.-]/.test(value)) return null;
  // An ISO date and an IPv4 address are both digit runs that carry separators
  // like a telephone number does: "2026-03-16 11" is ten digits that pass the
  // NANP test below, and "39.144.60.174" is another.
  if (/\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  if (value.startsWith("+")) return digits.length >= 8 ? `+${digits}` : null;
  // Without a plus, only shapes that identify their own country are accepted.
  // A labelled number in a report's table is printed bare ("8613341122552"),
  // and guessing a country for an arbitrary digit run would publish a number
  // this site cannot vouch for.
  //
  // A Chinese mobile is 86, then 1 and nine more digits. A Russian mobile
  // written with the domestic trunk prefix is 8, then 9 and nine more digits,
  // which is +7 and the last ten.
  if (digits.length === 13 && /^861/.test(digits)) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("89")) return `+7${digits.slice(1)}`;
  // NANP area codes and exchanges never begin with 0 or 1, which is what
  // separates a ten-digit telephone number from a Unix timestamp or an ID.
  const nanp = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (nanp && /^[2-9]\d{2}[2-9]\d{6}$/.test(nanp)) return `+1${nanp}`;
  return null;
}

/**
 * A digit run that might be a telephone number: an optional plus, a leading
 * group, and up to four more groups of two to four digits split by a single
 * space, dot or hyphen. Brackets around a group are allowed. The width limit
 * keeps two adjacent numbers from fusing into one.
 *
 * The shape is only a candidate. A digit run is the commonest thing in a
 * report, so looksLikePhoneContext decides whether one is a number.
 */
const PHONE_PATTERN =
  /(?<![\w.\-/@#$%+(])\+?\(?\d{1,4}\)?(?:[ .-]?\(?\d{2,4}\)?){1,4}(?![\w@]|[.-]\d)/g;

const PHONE_LABEL =
  /\b(?:phones?|telephones?|tel|mobiles?|cell|whatsapp|signal|contact\s+numbers?)\b/i;

/** A heading that is about phone numbers, as "Phone Numbers" or "Mobile numbers". */
const PHONE_HEADING = /\b(?:phones?|telephones?|mobiles?)(?:\s+numbers?)?\b/i;

/**
 * Words that mark a number as somebody's published contact details rather than
 * an indicator: the publisher's own address block ("Suite 1500", "Fax"), a
 * WHOIS or RIPE record ("Registrant Phone", "nic-hdl"), a court filing's
 * signature block. A report prints the registry's number beside the domain it
 * documents, and the vendor's switchboard in every page footer; neither
 * belongs to the operator, and the footer repeats on every page of a site.
 */
const PHONE_BOILERPLATE =
  /\bfax(?:-no)?\b|\bnic-hdl\b|\bmnt-by\b|\bregistra(?:r|nt)\b|\b(?:admin|tech)\s+phone\b|\bsuite\s+\d|\bfloor\b|\bblvd\b|\bavenue\b|\bstreet\b|\bp\.?o\.?\s+box\b|©|\bcopyright\b|\/s\/|\battorney\b|\besq\b|\bbar\s+no\b/i;

function isPhoneBoilerplate(text, index, length) {
  return PHONE_BOILERPLATE.test(text.slice(Math.max(0, index - 200), index + length + 200));
}

/**
 * Whether a digit run is labelled as a telephone number. Three ways in: the
 * current section is about phone numbers; the value's own line carries a phone
 * label, for a table row of at most 240 characters, which is how an indicator
 * table prints "8613341122552 phone number insider"; or a label sits within 40
 * characters before the value in the same sentence, for prose.
 */
function looksLikePhoneContext(text, index, section) {
  if (section && PHONE_HEADING.test(section)) return true;
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const endAt = text.indexOf("\n", index);
  const line = text.slice(start, endAt < 0 ? text.length : endAt);
  if (line.length <= 240 && PHONE_LABEL.test(line)) return true;
  let before = text.slice(Math.max(start, index - 40), index);
  const stop = before.lastIndexOf(". ");
  if (stop >= 0) before = before.slice(stop + 2);
  return PHONE_LABEL.test(before);
}

/**
 * Autonomous System numbers, written as reports do — "AS20485", "AS131279".
 *
 * Unlike an IP address, the shape alone is not enough: an ASN is unremarkable
 * infrastructure metadata until a report says whose it is and why it matters,
 * so this needs the same positive malicious-context gate as a wallet or npm
 * package rather than a plain exclusion list. Measured over the staged corpus,
 * 19 raw matches fall to 15 once the gate runs — every survivor is a hosting or
 * VPN provider a report names as carrying DPRK IT-worker or C2 traffic
 * (TransTeleCom AS20485, North Korea's own AS9341 and AS131279, QuadraNet
 * AS8100). The four rejected are the same information stated a second time in
 * a sentence this window reads as describing a victim ("operating from
 * legitimate regions") or with no qualifying language within reach in a bare
 * appendix line — under-reporting is the correct failure here.
 */
const ASN_PATTERN = /\bAS\d{2,6}\b/g;

/**
 * Numbers that carry the same "AS####" shape as an Autonomous System number
 * but name something else entirely — the IBM AS/400 platform and the AS9100
 * aerospace quality standard are both routinely written without the slash or
 * a space. Neither has been seen in this corpus, but both are common enough
 * in general technical writing that excluding them costs nothing.
 */
const ASN_KNOWN_NON_ASN = new Set(["400", "9100"]);

function normalizeAsn(raw) {
  const value = String(raw).trim().toUpperCase();
  const match = value.match(/^AS(\d{2,6})$/);
  if (!match) return null;
  const digits = match[1];
  // A leading zero is a typo or an OCR artifact, not a real ASN.
  if (digits[0] === "0") return null;
  if (ASN_KNOWN_NON_ASN.has(digits)) return null;
  return `AS${digits}`;
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * Role addresses belonging to the publisher of the report, not to anyone the
 * report is about. Without this the vendor's own press@ and sales@ addresses
 * become "DPRK IT worker indicators".
 */
const EMAIL_LOCAL_DENYLIST = new Set([
  "abuse", "admin", "billing", "contact", "editor", "enquiries", "feedback",
  "hello", "help", "hi", "info", "investors", "legal", "mail", "marketing",
  "media", "news", "newsletter", "noreply", "no-reply", "office", "postmaster",
  "press", "privacy", "pr", "sales", "security", "subscribe", "support",
  "team", "unsubscribe", "webmaster", "root", "example", "name", "your-email",
  "token", "username", "user", "apikey", "api",
  // npm's OIDC publishing robot, which signs provenance and turns up in any
  // write-up of a package takeover. The domain cannot be denied wholesale,
  // because users.noreply.github.com is a subdomain of it and those addresses
  // identify the operator's own account.
  "npm-oidc-no-reply",
]);

const EMAIL_DOMAIN_DENYLIST = [
  "example.com", "example.org", "example.net", "domain.com", "email.com",
  "yourcompany.com", "company.com", "sentry.io", "wordpress.org", "schema.org",
  // Managed-database hostnames, which turn up as the tail of a connection
  // string and never as a mail domain. kmsec's Contagious Trader writeup quotes
  // the strings the malware exfiltrates to, and
  // `roswelldev@cluster0.1ufrx5i.mongodb.net` reads to the address pattern as a
  // user at a domain. The cluster host is a real indicator, but it is the
  // operator's exfiltration endpoint and not an address anyone can write to.
  "mongodb.net",
  // The prosecutors who filed the case. A court document closes with a
  // signature block naming the Assistant United States Attorneys and their
  // government addresses, and DOJ's IT-worker forfeiture complaint contributed
  // three of them on its first run. That block is the reporting side of the
  // document in the most literal sense the corpus offers.
  "usdoj.gov",
  // The same shape, one department over. Reporting on sanctions prints the
  // OFAC address readers are told to send tips to, and ofacreport@treasury.gov
  // reached the index from a Merkle Science piece on Tornado Cash. A
  // government reporting inbox is the opposite of an operator's mailbox.
  "treasury.gov",
  // Google's corporate domain, as distinct from gmail.com, which is left alone
  // because most of this corpus lives there. Nothing operational is hosted at
  // google.com, and user2@google.com came in from an example table.
  "google.com",
  // Two vendors whose research arms publish under a different domain from
  // their corporate one, so the source-host guard never sees the match:
  // securelist.com signs off with intelreports@kaspersky.com and
  // welivesecurity.com with threatintel@eset.com. Both are inboxes for sending
  // findings to, which is the opposite of an operator's mailbox.
  "kaspersky.com",
  "eset.com",
  // Vendor and government contact domains whose blog lives on a different host,
  // so the source-host guard never matches them: Genians (blog on
  // genians.co.kr, contact tac@genians.com, which was indexed across 37
  // reports), ESTsecurity (blog on blog.alyac.co.kr, contact
  // esrc@estsecurity.com), and the US-CERT / CISA malware-submission and
  // contact addresses that sit in every advisory footer.
  "genians.com",
  "estsecurity.com",
  "us-cert.gov",
  "cisa.gov",
];

const HOST_DENYLIST = [
  "example.com", "example.org", "example.net", "schema.org", "w3.org",
  "twitter.com", "x.com", "facebook.com", "linkedin.com", "youtube.com",
  "instagram.com", "reddit.com", "t.me", "mastodon.social", "bsky.app",
  "wordpress.org", "wordpress.com", "creativecommons.org", "gravatar.com",
  "doubleclick.net", "google.com", "googletagmanager.com", "google-analytics.com",
  "apple.com", "microsoft.com", "adobe.com", "mozilla.org",
];

const CDN_HOST_PATTERNS = [
  /^cdn\./, /\.cdn\./, /\.cloudfront\.net$/, /\.akamaized\.net$/, /\.akamai\.net$/,
  /\.fastly\.net$/, /^static\./, /^assets\./, /^img\./, /^images\./, /^media\./,
  /\.gstatic\.com$/, /\.googleapis\.com$/, /\.licdn\.com$/, /\.twimg\.com$/,
  /\.ytimg\.com$/, /\.imgix\.net$/, /\.wp\.com$/, /\.staticflickr\.com$/,
];

const ASSET_EXTENSIONS =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|json|xml|rss|woff2?|ttf|eot|otf|mp[34]|webm|mov|zip|gz|tar|dmg|exe|msi)(?:$|\?)/i;

/** Suffix match, so a subdomain of a denied host is denied with it. */
function hostMatches(host, list) {
  if (!host) return false;
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * @param {object} opts
 * @param {string[]} [opts.excludedHosts] Seed-source hosts. Every host the
 *   scraper fetches is excluded along with its subdomains, so a report's own
 *   navigation, footer and author links never become indicators. The POC
 *   matched these exactly rather than by suffix, which is why
 *   unit42.paloaltonetworks.com — one of its own seed sources — was never
 *   excluded and its boilerplate ended up in the output.
 */
/**
 * Mail domains that are entirely numeric and entirely real. NetEase runs
 * 163.com, 126.com and 188.com; 139.com is China Mobile and 189.cn is China
 * Telecom. All five are ordinary consumer providers and turn up routinely in
 * this corpus, so the placeholder rule for all-digit domains has to step
 * around them rather than treating the shape alone as disqualifying.
 */
const NUMERIC_MAIL_PROVIDERS = new Set([
  "163.com",
  "126.com",
  "188.com",
  "139.com",
  "189.cn",
]);

/**
 * Extensions that a filename ends in and that ICANN has not delegated as a
 * top-level domain, so a "domain" ending in one is a file path every time.
 * Deliberately excludes md, sh, py, ai, io, zip and mov, which are all real
 * TLDs a genuine address can sit under.
 */
const FILE_EXTENSION_NOT_TLD =
  /\.(?:txt|json|csv|tsv|png|jpe?g|gif|webp|bmp|ico|svg|pdf|hwpx?|html?|xhtml|jspx?|aspx?|php|cgi|xml|yml|yaml|ini|cfg|conf|exe|dll|msi|bat|ps1|docx?|xlsx?|pptx?|rtf|odt|log|bak|tmp|sql|db|sqlite|gz|tgz|bz2|xz|rar|7z|tar|iso|dmg|pkg|deb|rpm)$/i;

/**
 * Whether an address matched at `index` in `prose` is only part of something
 * else, judged from where it sits. Three shapes reached the index as whole
 * addresses belonging to nobody in the report, or to a stranger:
 *
 * - The tail of a masked address. StealthMole prints h****_u@hotmail.com and
 *   su******d@hotmail.com; the pattern starts after the asterisks and indexed
 *   _u@hotmail.com and d@hotmail.com, real mailboxes of unconnected people.
 *   A report that prints wezard4u's no-reply+036d5d(d)0-3bd4-... breaks the
 *   same way at a parenthesis.
 * - The login part of a URL: ftp://root:1q2w3e4r%T^Y&U*I@lianxinxiao.com and
 *   ftp://u:u@b.smtper.co are a password and a host, not a mailbox. The host
 *   is the indicator, and the domain extractor takes it. An address in a
 *   URL's path is left alone: a leak's https://sg24.vps.bz:4083/center2025a@
 *   tutamail.com is a panel login naming a real operator mailbox.
 * - A per-message bounce address, whose local part carries a UUID. Each one
 *   is used once; the sending domain is the indicator.
 */
const MASK_BEFORE_EMAIL = /[*•●·)]$/;
const UUID_IN_LOCAL_PART = /[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isEmailFragment(prose, index, match) {
  const text = String(prose);
  if (index > 0 && MASK_BEFORE_EMAIL.test(text[index - 1])) return true;
  let start = index;
  while (start > 0 && !/[\s"'<>\[\](){}]/.test(text[start - 1])) start -= 1;
  // Only the login part, between the scheme and the first slash. An address
  // later in a URL's path (a panel login URL a leak printed) is still one.
  const token = text.slice(start, index);
  const scheme = token.indexOf("://");
  if (scheme !== -1 && !token.slice(scheme + 3).includes("/")) return true;
  const local = String((Array.isArray(match) ? match[0] : match) || "").split("@")[0];
  return UUID_IN_LOCAL_PART.test(local);
}

function isExcludedEmail(email, opts = {}) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return true;
  // A local part of one or two digits is what is left when a table cell breaks
  // mid-address or a publisher masks one: 0@hotmail.com, 2@gmail.com and
  // 23@163.com all reached the index from a single write-up. Nobody registers
  // those, and an address with no context quote beside it was the tell.
  if (/^\d{1,2}$/.test(local)) return true;
  if (EMAIL_LOCAL_DENYLIST.has(local.toLowerCase())) return true;
  if (hostMatches(domain, EMAIL_DOMAIN_DENYLIST)) return true;
  if (hostMatches(domain, opts.excludedHosts || [])) return true;
  // The author's own contact address on a mail host they do not own.
  //
  // The rule above drops press@<the source's own domain>, but publishers
  // routinely sign a post with their domain spelled as the LOCAL part of an
  // address somewhere else: kmsec.uk closes its Contagious Trader writeup with
  // kmsec-uk@proton.me under a heading offering to answer questions, and
  // chollima-group.io signs its posts chollima_group@proton.me. Nothing about
  // such an address marks it as the reporter rather than the reported, and
  // harvesting it publishes a researcher's inbox as a DPRK indicator.
  //
  // Separators are removed on both sides, so kmsec.uk catches kmsec-uk and
  // kmsec_uk. Four forms of the host are compared, because publishers pick
  // different parts of their own domain:
  //
  //   the whole host              kmsec.uk        -> kmsec-uk@
  //   the host minus its TLD      chollima-group.io -> chollima_group@
  //   any single label            dprk-research.kmsec.uk -> dprk-research@
  //
  // Everything but the whole host carries a ten-character floor, and that
  // number is measured rather than guessed. Below it sit the generic words the
  // seed list happens to contain -- "research" from research.jfrog.com,
  // "abstract", "treasury", "socket", "okta" -- each a plausible local part for
  // an operator or a phishing lure, and excluding okta@ would drop exactly the
  // kind of address this index wants. At ten and above, every label in the list
  // is a publisher's own name: chollimagroup, dprkresearch, opensourcemalware,
  // reversinglabs, theravenfile.
  const flatten = (value) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const flatLocal = flatten(local);
  const DISTINCTIVE = 10;
  for (const host of opts.excludedHosts || []) {
    const bare = host.replace(/^www\./i, "");
    if (flatten(host) === flatLocal || flatten(bare) === flatLocal) return true;
    const labels = bare.split(".");
    // The host without its final label, plus each label on its own.
    const forms = labels.length > 1 ? [labels.slice(0, -1).join("."), ...labels.slice(0, -1)] : [bare];
    for (const form of forms) {
      const flat = flatten(form);
      if (flat.length >= DISTINCTIVE && flat === flatLocal) return true;
    }
  }
  // Wildcard placeholders used in prose to describe a pattern, not an address.
  if (/[*]|^(?:first|last)name|^user$|^username$/i.test(local)) return true;
  // TLDs RFC 2606 reserves so they can never resolve. An address under one is
  // documentation or a test fixture by definition, and MSMT 2025/2 prints one
  // in an annex beside real addresses.
  if (/\.(?:test|example|invalid|localhost)$/i.test(domain)) return true;
  // The link-local and private-network suffixes, which are not RFC 2606 and so
  // were missed by the rule above. These do not appear as addresses at all —
  // they appear as the host half of an SSH or login command, and the pattern
  // cannot tell `ssh.exe pilot@tinypilot.local` from a real address. The
  // ReliaQuest IP-KVM report prints exactly that line and it was the only
  // false positive in that source's whole run.
  if (/\.(?:local|localdomain|internal|intranet|lan|home\.arpa)$/i.test(domain)) return true;
  // An address written to explain the FORM of an address rather than to name
  // one. The same report walks through "ABC+X@123.com" to define what a local
  // part and an alias are; a domain that is only digits is a placeholder, and
  // no operator in this corpus has ever used one.
  // ...unless it is one of the large Chinese consumer providers whose domain
  // genuinely is all digits. NetEase alone runs 163.com, 126.com and 188.com,
  // and the rule above was quietly discarding four real 163.com addresses from
  // GitLab's reporting. An all-digit domain is a placeholder by default, but
  // not when it is one of the biggest mail hosts in the world.
  if (/^\d+\.[a-z]+$/i.test(domain) && !NUMERIC_MAIL_PROVIDERS.has(domain.toLowerCase())) {
    return true;
  }
  // A file path that happens to contain an "@", not an address. tayvano's
  // readme links each operator's Telegram export as `./user-<id>-@<handle>.txt`,
  // and the pattern reads the trailing `.txt` as a TLD: 25 records in one
  // source, every one of them bogus, and every handle inside them already held
  // correctly as a telegram_account from the neighbouring t.me link.
  //
  // Only extensions that are NOT delegated TLDs are listed. Several real ones
  // collide — .md is Moldova, .sh Saint Helena, .py Paraguay, and .zip and .mov
  // are both live gTLDs — so excluding those by extension alone would throw
  // away deliverable addresses. They are left to be caught by context instead.
  if (FILE_EXTENSION_NOT_TLD.test(domain)) return true;
  return false;
}

/**
 * @param opts.platform The host this indicator type is FOR, e.g. "linkedin.com"
 *   for a linkedin_profile. HOST_DENYLIST contains the big social platforms so
 *   that a footer link to LinkedIn never becomes a "personal site" — but the
 *   same list, applied to the typed extractor, silently discarded every
 *   LinkedIn profile the scraper ever found. A typed extractor is exempt from
 *   the denylist entry for its own platform, and from any seed-source host
 *   that happens to match it.
 */
/**
 * The accounts that OWN the seed sources, for sources hosted on a code-sharing
 * platform.
 *
 * The seed-host exclusion keeps a publisher's own domain out, but when the
 * source IS a GitHub page the publisher is a path segment rather than a host:
 * raw.githubusercontent.com/tayvano/... and
 * gist.githubusercontent.com/N3mes1s/... are both in this corpus, and each
 * names its author where no host check can see it. Harvesting that publishes
 * the researcher who wrote the source as an indicator in it.
 */
/**
 * Hosts whose FIRST path segment is an account name.
 *
 * Exact hosts, not suffixes. Suffix matching pulled in hosts that merely sit
 * under the same domain and whose paths mean something else entirely:
 * about.gitlab.com/blog/... yielded the owner "blog", and
 * gitlab-com.gitlab.io/gl-security/... yielded "gl-security". The resulting set
 * is applied across every platform here rather than only the host it came from,
 * so "blog" would then have suppressed github.com/blog.
 */
const CODE_HOST_OWNER_PATHS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "gist.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
]);

function accountsOwningSources(sourceUrls = []) {
  const owners = new Set();
  for (const url of sourceUrls) {
    const host = hostOf(url);
    if (!host || !CODE_HOST_OWNER_PATHS.has(host)) continue;
    try {
      const segment = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).pathname
        .split("/")
        .filter(Boolean)[0];
      if (segment) owners.add(segment.toLowerCase());
    } catch {
      /* a malformed seed URL is not an owner */
    }
  }
  return [...owners];
}

function isExcludedUrl(url, opts = {}) {
  const host = hostOf(url);
  if (!host) return true;
  // See accountsOwningSources: the author of a source hosted on a code platform.
  if ((opts.excludedAccounts || []).length && CODE_HOST_OWNER_PATHS.has(host)) {
    try {
      const segment = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).pathname
        .split("/")
        .filter(Boolean)[0];
      if (segment && opts.excludedAccounts.includes(segment.toLowerCase())) return true;
    } catch {
      /* fall through to the normal checks */
    }
  }
  const platform = opts.platform ? [opts.platform] : [];
  const onOwnPlatform = hostMatches(host, platform);
  if (!onOwnPlatform && hostMatches(host, HOST_DENYLIST)) return true;
  if (!onOwnPlatform && hostMatches(host, opts.excludedHosts || [])) return true;
  if (CDN_HOST_PATTERNS.some((re) => re.test(host))) return true;
  if (ASSET_EXTENSIONS.test(url)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Context snippets
// ---------------------------------------------------------------------------

/**
 * A readable quote from the prose around an indicator, for display on the site.
 *
 * Snaps to word boundaries and prefers a sentence boundary inside the window,
 * because the POC's raw ±120-character slice started and ended mid-word. The
 * caller is responsible for only passing prose here — a window taken over a
 * page's link list yields a run of adjacent URLs, which is unreadable as a
 * quote (see `context_origin` on each stored source).
 */
function contextFor(text, start, end, window = 140) {
  let from = Math.max(0, start - window);
  let to = Math.min(text.length, end + window);

  const sentenceStart = text.lastIndexOf(". ", start);
  if (sentenceStart > from) from = sentenceStart + 2;
  else if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < start) from = space + 1;
  }

  const sentenceEnd = text.indexOf(". ", end);
  if (sentenceEnd !== -1 && sentenceEnd < to) to = sentenceEnd + 1;
  else if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > end) to = space;
  }

  const snippet = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (!snippet) return "";
  return `${from > 0 ? "…" : ""}${snippet}${to < text.length ? "…" : ""}`;
}

// ---------------------------------------------------------------------------
// Record identity
// ---------------------------------------------------------------------------

/**
 * Stable across re-ingestion, so a URL fragment linking to one indicator keeps
 * working after the dataset is regenerated.
 */
/**
 * Domain-shaped tokens, matched loosely because the guard is what restricts
 * them. See the domain entry in EXTRACTORS in scrape-dprk-iocs.js: a match
 * only survives if it stands alone on its line inside a block headed as
 * network infrastructure, which is the attribution this pattern cannot make.
 */
const DOMAIN_IN_BLOCK_PATTERN = /\b(?:[a-z0-9][a-z0-9-]{0,61}\.)+[a-z]{2,24}\b/gi;

/**
 * The exclusions a block heading cannot make on the author's behalf.
 *
 * A heading says "these are C2", and mostly the values beneath it are. What it
 * does not do is stop a report from listing a legitimate service in the same
 * block -- an advisory naming the mail provider a lure abused, or the hosting
 * platform a payload sat on. The shared denylists already carry those, so this
 * reuses them rather than starting a second list that would drift.
 *
 * The free-hosting platforms are excluded as bare domains for a different
 * reason: vercel.app itself is not an indicator, only an attacker-chosen
 * subdomain of it is, and those already have their own type in
 * HOSTED_SITE_PATTERN.
 */
/**
 * Blockchain-name suffixes, which are not DNS at all.
 *
 * .eth and its neighbours resolve through a naming contract, not a registrar,
 * and this corpus already gives them their own type. Without this, a "C2"
 * block that lists an operator's ENS name beside its domains publishes the
 * same value twice under two types: DOJ's forfeiture complaint contributed
 * vhurryharry.eth and halfmooneye.eth that way.
 */
const BLOCKCHAIN_NAME_SUFFIXES =
  /\.(?:eth|crypto|nft|wallet|dao|bitcoin|blockchain|zil|bnb|x|888|klever|hi|kresus|anime|manga|polygon|sol|tez|btc)$/i;

/**
 * Public infrastructure a report lists because the malware talked to it.
 *
 * This is where the block gate stops being enough, and it is worth being plain
 * about why. A "C2" heading records the report author's judgment, and this
 * site's bar is higher than that judgment: ReversingLabs lists polygon-rpc.com
 * and rpc-amoy.polygon.technology under "C2 domains and IP addresses" because
 * the loader reads its real endpoint off the chain through them, which makes
 * them infrastructure the operator used and not infrastructure the operator
 * controls. Republishing them would tell a defender to block the public
 * Polygon RPC.
 *
 * Every entry here is a service anyone can use, so no entry can ever be an
 * operator-controlled domain. Where a report is right that a value is hostile,
 * it will not be on this list.
 */
const PUBLIC_INFRASTRUCTURE_DOMAINS = [
  // Blockchain RPC and node providers.
  "polygon-rpc.com", "polygon.technology", "infura.io", "alchemy.com",
  "ankr.com", "quicknode.com", "quiknode.pro", "llamarpc.com", "blastapi.io",
  "publicnode.com", "drpc.org", "chainstack.com", "cloudflare-eth.com",
  "binance.org", "bsc-dataseed.binance.org", "blockdaemon.com", "getblock.io",
  "moralis.io", "nodereal.io", "onfinality.io", "rpcpool.com", "helius-rpc.com",
  "mainnet-beta.solana.com", "solana.com", "arbitrum.io", "optimism.io",
  "base.org", "avax.network", "tron.network", "trongrid.io", "etherscan.io",
  "bscscan.com", "polygonscan.com", "blockchain.info", "blockchair.com",
  // IPFS and decentralised storage gateways.
  "ipfs.io", "pinata.cloud", "dweb.link", "w3s.link", "nftstorage.link",
  "infura-ipfs.io", "cloudflare-ipfs.com", "arweave.net", "filebase.io",
];

/**
 * Mail providers, which are never what this type means.
 *
 * This type is for a registered domain an operator controls. A consumer mail
 * provider is the opposite of that -- it is the domain an operator borrowed an
 * address at, and those addresses already have their own type. The block gate
 * makes this unlikely rather than impossible, and the cost of being wrong here
 * is the site naming gmail.com as DPRK infrastructure, so it is written down.
 */
const MAIL_PROVIDER_DOMAINS = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "icloud.com", "me.com", "aol.com", "gmx.com", "gmx.net", "mail.com",
  "mail.ru", "yandex.ru", "yandex.com", "zoho.com", "tutanota.com",
  "naver.com", "daum.net", "hanmail.net", "qq.com", "foxmail.com",
];

function isExcludedDomain(domain, opts = {}) {
  const host = String(domain).toLowerCase();
  if (!host) return true;
  if (hostMatches(host, HOST_DENYLIST)) return true;
  if (hostMatches(host, opts.excludedHosts || [])) return true;
  if (CDN_HOST_PATTERNS.some((re) => re.test(host))) return true;
  // A subdomain of a free-hosting platform is the hosted_site type, not this
  // one. Without this the same value is published twice under two types:
  // Socket's writeup put tetrismic.vercel.app and knightsbridge-dex.vercel.app
  // in a C2 block, and both were already extracted as hosted sites.
  if (hostMatches(host, HOSTED_SITE_HOSTS)) return true;
  // A paste or JSON-bin service is shared by everyone; only a URL on it is an
  // indicator, and that is the payload_url type. See PAYLOAD_URL_HOSTS.
  if (hostMatches(host, PAYLOAD_URL_HOSTS)) return true;
  if (EMAIL_DOMAIN_DENYLIST.includes(host)) return true;
  if (hostMatches(host, MAIL_PROVIDER_DOMAINS)) return true;
  if (hostMatches(host, PUBLIC_INFRASTRUCTURE_DOMAINS)) return true;
  if (BLOCKCHAIN_NAME_SUFFIXES.test(host)) return true;
  if (NUMERIC_MAIL_PROVIDERS.has(host)) return true;
  // A trailing label that is a file extension is a filename, not a host. The
  // same rule the mail-domain gate applies, and it matters more here: an
  // appendix lists payload filenames a line away from the domains.
  if (FILE_EXTENSION_NOT_TLD.test(host)) return true;
  return false;
}

function recordId(iocType, value) {
  const digest = crypto
    .createHash("sha1")
    .update(`${iocType}:${value}`)
    .digest("hex")
    .slice(0, 12);
  return `${iocType.replace(/_/g, "-")}-${digest}`;
}

module.exports = {
  EMAIL_PATTERN,
  IPV4_PATTERN,
  LINKEDIN_PATTERN,
  GITHUB_PATTERN,
  GITHUB_BARE_REPO_PATTERN,
  NPM_PACKAGE_PATTERN,
  NPM_TABLE_ROW_PATTERN,
  PAYLOAD_URL_HOSTS,
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
  sectionLabelOf,
  CHROME_WEBSTORE_PATTERN,
  CHROME_EXTENSION_ID_PATTERN,
  PLATFORM_ACCOUNTS,
  platformAccountPattern,
  normalizePlatformAccount,
  WALLET_PATTERNS,
  walletChain,
  normalizeWallet,
  ENS_PATTERN,
  normalizeEns,
  SKYPE_PATTERN,
  normalizeSkype,
  DOMAIN_PATTERN,
  normalizeDomain,
  normalizeAlias,
  DOMAIN_IN_BLOCK_PATTERN,
  isExcludedDomain,
  HOSTED_SITE_PATTERN,
  normalizeHostedSite,
  defang,
  decodeCfEmail,
  normalizeUrl,
  safeDecode,
  normalizeEmail,
  canonicalMailbox,
  DOT_INSENSITIVE_HOSTS,
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
  normalizeIpv4,
  normalizePhone,
  PHONE_PATTERN,
  looksLikePhoneContext,
  isPhoneBoilerplate,
  isReservedIpv4,
  isVersionShapedIpv4,
  PUBLIC_RESOLVER_IPS,
  CDN_EDGE_RANGES,
  isInIpv4Range,
  ASN_PATTERN,
  normalizeAsn,
  isExcludedEmail,
  isEmailFragment,
  isExcludedUrl,
  accountsOwningSources,
  withScheme,
  hostOf,
  hostMatches,
  contextFor,
  recordId,
};
