// scan-match-kind.js
// ============================================================================
// Classifies a repo-scanner match as research/detection tooling rather than a
// possibly compromised project. A detection-rule or threat-intel repository
// that quotes an indicator on purpose (a YARA rule, a CSV of published IOCs, a
// scanner built to find PolinRider's own injection pattern) renders identically
// to a compromised repository in the scan-match table unless it is flagged: the
// same indicator string shows up in the same table with the same columns
// either way. This is a heuristic on the match's path and repository name, not
// a verified classification -- see docs/repo-scanner-github-scan.md.
//
// Shared by .eleventy.js (renders the flag in the scan-match table) and
// scripts/run-repo-scan.js (records it on each match going forward) so the
// two never drift apart.
// ============================================================================

// Path segments/filenames that mark a file as detection tooling or an
// indicator collection rather than application code. Checked as a whole token
// of the lowercased path, bounded by the start or end of the string or one of
// - _ . / or a camelCase hump, with an optional plural "s": "IOC-HUB/README.md",
// "src/iocs.json" and "AdhocCheckIOC.csv" all match on "ioc", "samples/" on
// "sample" and "polinRiderScanner" on "scanner". A substring match classed
// "audioconverter" and "social-app" as detection tooling ("ioc" inside a
// word), which put a compromised repository on /repo-scanner/ as research.
// "test" alone was tried and dropped: it matched ordinary application code
// with no connection to detection tooling ("frontend_test/package.json",
// "test-requirements.txt", "images-testp2.zip"), which is exactly the false
// positive this tag exists to avoid. "fixture" is kept, since a fixtures/
// directory of known-bad samples is a narrower, more reliable signal.
const RESEARCH_PATH_TOKENS = [
  "ioc",
  "iocs",
  "indicator",
  "signature",
  "threat-intel",
  "threatintel",
  "detection",
  "rules",
  "scanner",
  "cleanup",
  "cleaner",
  "sample",
  "poc",
  "fixture",
];

// Rule-engine file extensions. On their own a .yml is just as likely to be a
// CI config, so this only counts when the path also sits under a rules/
// detections directory -- checked separately below, not folded into
// RESEARCH_PATH_TOKENS.
const RULE_FILE_EXTENSIONS = /\.(ya?ml|yara?)$/i;
const RULE_DIRECTORY_SEGMENT = /(^|\/)(rules|detections)(\/|$)/i;

// Repository (or owner/repository) name fragments that mark the project
// itself as detection tooling or a published indicator set, independent of
// which file matched.
const RESEARCH_REPO_TOKENS = [
  "ioc",
  "threat-intel",
  "threatintel",
  "yara",
  "scanner",
  "cleanup",
  "cleaner",
  "workshop",
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokenPattern = (tokens) =>
  new RegExp(`(?:^|[-_./])(?:${tokens.map(escapeRegExp).join("|")})s?(?=$|[-_./])`);
const RESEARCH_PATH_PATTERN = tokenPattern(RESEARCH_PATH_TOKENS);
const RESEARCH_REPO_PATTERN = tokenPattern(RESEARCH_REPO_TOKENS);

function containsToken(haystack, pattern) {
  const text = String(haystack || "");
  const humps = text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2");
  return pattern.test(text.toLowerCase()) || pattern.test(humps.toLowerCase());
}

// Pulls "owner/repo" and the file path out of a scan match's `location`
// (a full GitHub blob URL), the same shape .eleventy.js's githubLocationLabel
// filter parses. Returns nulls for anything that isn't that shape rather than
// guessing.
function parseLocation(location) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)$/.exec(
    location || ""
  );
  if (!m) return { repo: null, filePath: null };
  return { repo: m[1], filePath: m[2] };
}

/**
 * scanMatchKind(match) -> "research" | null
 *
 * "research" when the match's location looks like detection tooling or an
 * indicator collection: a repository name carrying one of the
 * RESEARCH_REPO_TOKENS, a file path carrying one of the RESEARCH_PATH_TOKENS,
 * or a rule-engine file (.yml/.yaml/.yara/.yar) sitting under a rules/ or
 * detections/ directory. Returns null otherwise, including when `location`
 * isn't a parseable GitHub blob URL.
 */
function scanMatchKind(match) {
  if (!match) return null;
  const { repo, filePath } = parseLocation(match.location);

  if (repo && containsToken(repo, RESEARCH_REPO_PATTERN)) return "research";
  if (filePath && containsToken(filePath, RESEARCH_PATH_PATTERN)) return "research";
  if (
    filePath &&
    RULE_FILE_EXTENSIONS.test(filePath) &&
    RULE_DIRECTORY_SEGMENT.test(filePath)
  ) {
    return "research";
  }
  return null;
}

module.exports = { scanMatchKind, parseLocation };
