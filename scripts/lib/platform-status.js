/**
 * platform-status.js — whether a non-GitHub, non-LinkedIn account still exists
 * ==========================================================================
 * Reads scripts/data/platform-account-status.json, written by
 * scripts/enrich-platform-accounts.js, and answers for one indicator. Used by
 * scripts/lib/dossiers.js for curated records and by src/_data/iocIndex.js for
 * every merged record, so a persona page, an indicator page and the search
 * all show the same status. An account the check could not answer returns
 * null, which the pages render as "not checked".
 */
"use strict";

const path = require("path");
const { readJsonIfPresent } = require("./read-json.js");

const STATUS_PATH = path.join(__dirname, "..", "data", "platform-account-status.json");

const byKey = (() => {
  const map = new Map();
  // No file yet: every platform account reads as not checked.
  const doc = readJsonIfPresent(STATUS_PATH, { accounts: [] });
  for (const a of doc.accounts || []) map.set(`${a.type}|${String(a.value).toLowerCase()}`, a);
  return map;
})();

function platformAccountStatus(iocType, value) {
  const found = byKey.get(`${iocType}|${String(value).toLowerCase()}`);
  return found ? { state: found.state, checked: found.checked } : null;
}

module.exports = { platformAccountStatus };
