/**
 * enrichment-shapes.js — the shape the build expects of each file under
 * scripts/data/ that it reads
 * ==========================================================================
 * The readers (scripts/lib/dossiers.js, malware-status.js, platform-status.js,
 * src/_data/iocIndex.js, src/_data/sources.js) take these files as written.
 * scripts/validate-data.js checks each one against the rules here before a
 * build, and scripts/enrich-ips.js checks every row a lookup service returns
 * before it writes one.
 */
"use strict";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v) => typeof v === "string" && v.length > 0;
const optString = (v) => v === null || v === undefined || typeof v === "string";
const optBool = (v) => v === undefined || typeof v === "boolean";
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

const IP_KINDS = new Set(["vpn", "proxy", "datacenter", "mobile", "fixed-line", "unresolved"]);

/** Problems with one ip-lookups.json address entry, [] when it is sound. */
function ipLookupProblems(entry) {
  if (!isObject(entry)) return ["is not an object"];
  const out = [];
  if (!IP_KINDS.has(entry.kind)) out.push(`kind "${entry.kind}" is not one of ${[...IP_KINDS].join("/")}`);
  for (const key of ["provider", "country", "country_name", "isp", "org", "asn", "as_name", "note"]) {
    if (!optString(entry[key])) out.push(`${key} is not a string or null`);
  }
  if (entry.country && !/^[A-Z]{2}$/.test(entry.country)) out.push(`country "${entry.country}" is not a two-letter code`);
  for (const key of ["hosting", "proxy", "mobile"]) {
    if (!optBool(entry[key])) out.push(`${key} is not a boolean`);
  }
  if (entry.checked !== undefined && !isDay(entry.checked)) out.push(`checked "${entry.checked}" is not a date`);
  return out;
}

function listOf(doc, key, rowProblems) {
  if (!isObject(doc)) return ["top level is not an object"];
  if (!Array.isArray(doc[key])) return [`${key} is not an array`];
  const out = [];
  doc[key].forEach((row, i) => {
    for (const p of rowProblems(row)) out.push(`${key}[${i}] ${p}`);
  });
  return out;
}

function mapOf(doc, key, rowProblems) {
  if (!isObject(doc)) return ["top level is not an object"];
  if (!isObject(doc[key])) return [`${key} is not an object`];
  const out = [];
  for (const [name, row] of Object.entries(doc[key])) {
    for (const p of rowProblems(row)) out.push(`${key}["${name}"] ${p}`);
  }
  return out;
}

const stateRow = (states, keyField) => (row) => {
  if (!isObject(row)) return ["is not an object"];
  const out = [];
  if (!isString(row[keyField])) out.push(`${keyField} is missing`);
  if (!states.includes(row.state)) out.push(`state "${row.state}" is not ${states.join("/")}`);
  if (row.checked !== undefined && !isDay(row.checked)) out.push(`checked "${row.checked}" is not a date`);
  return out;
};

/** File name under scripts/data/ -> function(doc) returning a list of problems. */
const SHAPES = {
  "ip-lookups.json": (doc) => mapOf(doc, "addresses", ipLookupProblems),
  "linkedin-account-status.json": (doc) => listOf(doc, "accounts", stateRow(["live", "removed"], "slug")),
  "github-account-status.json": (doc) => listOf(doc, "accounts", stateRow(["live", "removed", "recycled"], "login")),
  "platform-account-status.json": (doc) =>
    listOf(doc, "accounts", (row) => [
      ...stateRow(["live", "removed"], "value")(row),
      ...(isObject(row) && !isString(row.type) ? ["type is missing"] : []),
    ]),
  "malware-status.json": (doc) =>
    listOf(doc, "items", (row) => [
      ...stateRow(["live", "removed"], "value")(row),
      ...(isObject(row) && !isString(row.type) ? ["type is missing"] : []),
    ]),
  "phone-lookups.json": (doc) =>
    listOf(doc, "numbers", (row) => {
      if (!isObject(row)) return ["is not an object"];
      const out = [];
      if (!isString(row.value) || !/^\+\d{7,15}$/.test(row.value)) out.push(`value "${row.value}" is not E.164`);
      if (row.names !== undefined && !Array.isArray(row.names)) out.push("names is not an array");
      if (row.sources !== undefined && !Array.isArray(row.sources)) out.push("sources is not an array");
      return out;
    }),
  "gh-analyzer.json": (doc) =>
    mapOf(doc, "accounts", (row) => {
      if (!isObject(row)) return ["is not an object"];
      const out = [];
      for (const key of ["commit_emails", "commit_names", "dprk_naming", "following_indexed", "followers_indexed", "mutual_indexed", "backdated_examples"]) {
        if (row[key] !== undefined && !Array.isArray(row[key])) out.push(`${key} is not an array`);
      }
      return out;
    }),
  "source-dates.json": (doc) =>
    mapOf(doc, "dates", (row) =>
      isObject(row) && typeof row.date === "string" && /^\d{4}(-\d{2}){0,2}$/.test(row.date)
        ? []
        : [`date "${row && row.date}" is not YYYY, YYYY-MM or YYYY-MM-DD`]
    ),
  "lazarus-registry-images.json": (doc) =>
    mapOf(doc, "images", (row) => (isObject(row) && typeof row.use === "boolean" ? [] : ["use is not a boolean"])),
};

module.exports = { SHAPES, ipLookupProblems, IP_KINDS };
