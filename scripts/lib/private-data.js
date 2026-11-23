/**
 * private-data.js — the maintainer's private working data.
 *
 * `_drafts/` is not part of this repository: it is a separate, private
 * repository checked out inside it and ignored here. `_drafts/private/` holds
 * what the site deliberately never publishes, such as values withheld because
 * they belong to people who are not accused of anything. A checkout without it
 * (CI, a fresh clone) still builds the public site in full.
 *
 * Where a public script has to recognise a withheld value without printing it,
 * the public file carries only `seal(value)`, a SHA-256 of the lowercased
 * value, and the readable entry lives here. `npm run seal` regenerates the
 * sealed lists from the readable ones.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PRIVATE_DIR = path.join(__dirname, "..", "..", "_drafts", "private");

function privatePath(...parts) {
  return path.join(PRIVATE_DIR, ...parts);
}

function hasPrivateData() {
  return fs.existsSync(PRIVATE_DIR);
}

function readPrivateJson(name, fallback) {
  const file = privatePath(name);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function seal(value) {
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

const FALSE_POSITIVES_PATH = path.join(__dirname, "..", "data", "false-positives.json");
const FREE_MAIL = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "proton.me", "protonmail.com"];

/**
 * A predicate that is true for a value judged a false positive. The judgement
 * holds whichever source carries the value: ingest prunes scraped records, but
 * a bulk list, a registry or a dossier would bring it straight back, so the
 * index and the persona pages both filter through this.
 */
function isFalsePositive() {
  const doc = fs.existsSync(FALSE_POSITIVES_PATH)
    ? JSON.parse(fs.readFileSync(FALSE_POSITIVES_PATH, "utf8"))
    : { values: [] };
  const sealed = new Set((doc.values || []).map((v) => v.sealed).filter(Boolean));
  return (value) => sealed.has(seal(value));
}

/**
 * A function that replaces every false-positive value quoted in a passage
 * with "[withheld]". Withdrawing a value from the index is not enough when a
 * neighbouring record's quote, cut from the same table, still prints it. Each
 * token is sealed and tested once: an address, host or URL also with the
 * scheme the index stores, and a bare handle (a list of logins) as the GitHub
 * and Telegram account it would name.
 */
function falsePositiveScrubber(falsePositive = isFalsePositive()) {
  const seen = new Map();
  const hit = (token) => {
    if (!seen.has(token)) {
      const bare = token.replace(/\/+$/, "");
      // An address the quote window cut short ("name@gmail.") is tried
      // against the free-mail domains it could have been.
      const local = /^[^@]+@[a-z.]*$/i.test(bare) ? bare.split("@")[0] : null;
      const forms = /[@./]/.test(bare)
        ? [token, bare, `https://${bare}`, `https://${bare}/`, ...(local ? FREE_MAIL.map((d) => `${local}@${d}`) : [])]
        : [`https://github.com/${bare}`, `https://t.me/${bare}`];
      seen.set(token, forms.some((form) => falsePositive(form)));
    }
    return seen.get(token);
  };
  return (text) =>
    typeof text !== "string"
      ? text
      : text.replace(/[^\s"'<>()\[\],;]+/g, (token) => {
          const [, lead, core, trail] = token.match(/^([^\p{L}\p{N}]*)(.*?)([.:!?…]*)$/u);
          return core.length > 3 && hit(core) ? `${lead}[withheld]${trail}` : token;
        });
}

module.exports = { PRIVATE_DIR, privatePath, hasPrivateData, readPrivateJson, seal, isFalsePositive, falsePositiveScrubber };
