/**
 * candidatePages.js — the rows /remote-workers/candidates/ lists, in its
 * default order, and the one page each gets at
 * /remote-workers/candidates/{slug}/. The rules are in
 * scripts/lib/candidates.js, shared with the search records.
 */
const fs = require("fs");
const path = require("path");
const { publishedCandidates } = require("../../scripts/lib/candidates.js");

module.exports = function () {
  const file = path.join(__dirname, "iocs", "candidates.json");
  return publishedCandidates(JSON.parse(fs.readFileSync(file, "utf8")));
};
