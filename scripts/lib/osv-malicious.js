/**
 * osv-malicious.js — OSV malicious-package advisories for an indexed package
 * ==========================================================================
 * Reads scripts/data/osv-malicious.json, written by
 * scripts/enrich-osv-malicious.js, and answers for one npm or PyPI indicator:
 * the MAL- advisories OSV holds for the package name, each with its id,
 * published date and summary. src/_data/iocIndex.js attaches the list to the
 * record as osv_advisories, which partials/ioc-detail.njk shows as links to
 * osv.dev.
 */
"use strict";

const path = require("path");
const { readJsonIfPresent } = require("./read-json.js");

const DATA_PATH = path.join(__dirname, "..", "data", "osv-malicious.json");

const byKey = (() => {
  const map = new Map();
  // Not checked yet: no record carries an advisory.
  const doc = readJsonIfPresent(DATA_PATH, { items: [] });
  for (const x of doc.items || []) map.set(`${x.type}|${String(x.name).toLowerCase()}`, x.advisories || []);
  return map;
})();

// "@scope/name@1.2.3" or "name@1.2.3" or a bare name.
function packageName(value) {
  const m = /^(@?[^@]+)(?:@(.+))?$/.exec(String(value));
  return m ? m[1] : String(value);
}

function osvAdvisories(iocType, value) {
  const found = byKey.get(`${iocType}|${packageName(value).toLowerCase()}`);
  return found && found.length ? found : null;
}

module.exports = { osvAdvisories };
