/**
 * read-json.js — reading a data file that may not exist yet
 * ==========================================================================
 * An enrichment file (a status sweep, a lookup table) is absent until its
 * script first runs, and the build renders without it. A file that is present
 * but will not parse is a different thing: a truncated write or a bad merge,
 * which would otherwise build a complete site with every badge it feeds
 * silently missing. Only the missing file falls back; anything else throws
 * with the file named.
 */
"use strict";

const fs = require("fs");

function readJsonIfPresent(filePath, fallback) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
}

module.exports = { readJsonIfPresent };
