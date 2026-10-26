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

module.exports = { PRIVATE_DIR, privatePath, hasPrivateData, readPrivateJson, seal };
