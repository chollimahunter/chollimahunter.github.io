/**
 * hunt-schema.js — the v2 hunt-query schema, as a pure function
 * =============================================================
 * `huntSchemaProblems(hunt)` returns one { field, problem } per way a hunt in
 * src/_data/hunts/hunts.json departs from the schema: the OS coverage in
 * `platforms`, the pseudo-logic in `logic`, and, per query, the fixed
 * technology vocabulary in `platform`, the matching `language`, a one-sentence
 * `note` and the `tuning` list. scripts/validate-data.js calls it for every
 * hunt; scripts/lib/hunt-schema.test.js exercises it on synthetic hunts.
 */
"use strict";

const OS_PLATFORMS = ["Windows", "macOS", "Linux", "Identity / cloud", "Network"];

const LOGIC_PREFIXES = ["Collect: ", "Match: ", "Exclude: ", "Report: "];
const LOGIC_MIN = 2;
const LOGIC_MAX = 6;
const LOGIC_LINE_MAX = 140;
const NOTE_TERMINATORS_MAX = 2;

// Query platform -> the languages it may carry.
const QUERY_LANGUAGES = {
  "Defender / Sentinel KQL": ["kql"],
  "Splunk SPL": ["spl"],
  "Sigma": ["yaml"],
  "CrowdStrike LogScale": ["logscale"],
  "Elastic": ["esql", "eql"],
  "Cortex XQL": ["xql"],
  "osquery": ["sql"],
  "YARA": ["yara"],
  "Shodan / Censys": ["text"],
};

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

function huntSchemaProblems(hunt) {
  const out = [];
  const add = (field, problem) => out.push({ field, problem });

  if (!Array.isArray(hunt.platforms) || hunt.platforms.length === 0) {
    add("platforms", "must be a non-empty array");
  } else {
    hunt.platforms.forEach((p, i) => {
      if (!OS_PLATFORMS.includes(p)) add(`platforms[${i}]`, `"${p}" is not one of ${OS_PLATFORMS.join(", ")}`);
    });
    if (new Set(hunt.platforms).size !== hunt.platforms.length) add("platforms", "repeats a value");
  }

  if (!Array.isArray(hunt.logic)) {
    add("logic", "must be an array of 2 to 6 strings");
  } else {
    if (hunt.logic.length < LOGIC_MIN || hunt.logic.length > LOGIC_MAX) {
      add("logic", `has ${hunt.logic.length} lines, expected ${LOGIC_MIN} to ${LOGIC_MAX}`);
    }
    hunt.logic.forEach((line, i) => {
      if (typeof line !== "string") return add(`logic[${i}]`, "is not a string");
      if (line.length > LOGIC_LINE_MAX) add(`logic[${i}]`, `is ${line.length} characters, the limit is ${LOGIC_LINE_MAX}`);
      if (!LOGIC_PREFIXES.some((p) => line.startsWith(p))) {
        add(`logic[${i}]`, `must start with ${LOGIC_PREFIXES.map((p) => `"${p}"`).join(", ")}`);
      }
    });
    const has = (prefix) => hunt.logic.some((l) => typeof l === "string" && l.startsWith(prefix));
    if (!has("Match: ")) add("logic", 'has no "Match: " line');
    if (!has("Report: ")) add("logic", 'has no "Report: " line');
  }

  const seen = new Set();
  (hunt.queries || []).forEach((q, i) => {
    const at = `queries[${i}]`;
    if (!Object.prototype.hasOwnProperty.call(QUERY_LANGUAGES, q.platform)) {
      add(`${at}.platform`, `"${q.platform}" is not one of ${Object.keys(QUERY_LANGUAGES).join(", ")}`);
    } else {
      if (seen.has(q.platform)) add(`${at}.platform`, `"${q.platform}" appears twice in this hunt`);
      seen.add(q.platform);
      if (!QUERY_LANGUAGES[q.platform].includes(q.language)) {
        add(`${at}.language`, `"${q.language}" does not match ${q.platform} (expected ${QUERY_LANGUAGES[q.platform].join(" or ")})`);
      }
    }
    if (!nonEmpty(q.note)) {
      add(`${at}.note`, "missing or empty");
    } else {
      const terminators = (q.note.match(/[.!?](?=\s|$)/g) || []).length;
      if (terminators > NOTE_TERMINATORS_MAX) add(`${at}.note`, `is more than one sentence (${terminators} sentence terminators)`);
    }
    if (!Array.isArray(q.tuning)) {
      add(`${at}.tuning`, "must be an array (empty when every clause is high fidelity)");
    } else {
      q.tuning.forEach((t, j) => {
        for (const key of ["part", "reason", "remove"]) {
          if (!t || !nonEmpty(t[key])) add(`${at}.tuning[${j}].${key}`, "missing or empty");
        }
      });
    }
  });

  return out;
}

module.exports = { huntSchemaProblems, OS_PLATFORMS, QUERY_LANGUAGES };
