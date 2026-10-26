// token-match.js
// ============================================================================
// Exact-token verification for repo-scanner domain, IP, wallet and filename
// rules. GitHub code search matches substrings, so "foo.com" also returns
// "evilfoo.com" and "1.2.3.4" also returns "11.2.3.45". These functions decide,
// from a matched file's text (or, for a filename, its path), whether the rule's
// value appears as a whole token. The text is only scanned, never executed.
// ============================================================================

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `value` occurs in `text` with the `before`/`after` lookarounds satisfied. */
function containsBounded(text, value, flags, before, after) {
  return new RegExp(`${before}${escapeRegex(value)}${after}`, flags).test(text);
}

/**
 * Domain: not preceded by a letter, digit or hyphen, so evilfoo.com is not
 * foo.com, but a preceding dot is allowed, because www.foo.com and
 * api.foo.com are the same operator's host. Not followed by [a-z0-9-] or a
 * dot and a letter or digit (foo.com.au). A path, port or sentence-final dot
 * is allowed.
 */
function hasDomain(text, domain) {
  return containsBounded(text, String(domain).trim(), "i", "(?<![A-Za-z0-9-])", "(?![A-Za-z0-9-])(?!\\.[A-Za-z0-9])");
}

/** IP: not preceded by a digit or dot, not followed by a digit or a dot-and-digit continuation. */
function hasIp(text, ip) {
  return containsBounded(text, String(ip).trim(), "", "(?<![0-9.])", "(?![0-9])(?!\\.[0-9])");
}

/** Wallet: exact token, case-insensitive only for 0x hex addresses. */
function hasWallet(text, address) {
  const a = String(address).trim();
  const hex = /^0x[0-9a-fA-F]+$/.test(a);
  return containsBounded(text, a, hex ? "i" : "", "(?<![A-Za-z0-9])", "(?![A-Za-z0-9])");
}

/** Filename: the path's basename equals one of the rule's names (a " / "-separated list), case-insensitive. */
function filenameMatches(filePath, value) {
  const full = String(filePath).toLowerCase();
  const base = full.split("/").pop();
  return String(value)
    .split(" / ")
    .map((p) => p.trim().toLowerCase())
    .some((p) => {
      if (!p) return false;
      // A rule that is itself a path (vendor/run.sh) must match the path's tail.
      if (p.includes("/")) return full === p || full.endsWith(`/${p}`);
      return base === p;
    });
}

const TOKEN_TYPES = new Set(["domain", "ip_address", "wallet_address", "filename"]);

/** True for a rule kind this module can verify. */
function isTokenType(iocType) {
  return TOKEN_TYPES.has(iocType);
}

/** True when the rule kind needs the file's text (everything but a filename). */
function needsText(iocType) {
  return iocType !== "filename";
}

/** Dispatches on ioc_type; returns null for a kind this module does not verify. */
function containsToken(iocType, value, text, filePath) {
  switch (iocType) {
    case "domain": return hasDomain(text, value);
    case "ip_address": return hasIp(text, value);
    case "wallet_address": return hasWallet(text, value);
    case "filename": return filenameMatches(filePath, value);
    default: return null;
  }
}

module.exports = { hasDomain, hasIp, hasWallet, filenameMatches, isTokenType, needsText, containsToken };
