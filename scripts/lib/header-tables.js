"use strict";

/**
 * Indicator tables typed by their header row rather than by each row.
 *
 * NPM_TABLE_ROW_PATTERN (ioc-normalize.js) takes a package name only from a
 * row whose own type column says "npm package". Many reports instead put the
 * type in the header ("package_name | version | SHA1") and the registry in the
 * heading or label above the table ("npm packages:", "PyPI package:"). Once
 * the page is flattened to text those cells are loose lines with no type, so
 * ReversingLabs' PromptMink report of April 2026 gave the scraper its C2 hosts
 * and none of its 63 packages or 304 digests. This reads the HTML tables
 * before they are flattened.
 *
 * Fail-closed, like the rest of the extractor: a table is read only when a
 * header cell names a package or a hash algorithm AND one of the headings
 * above it, or the label line just before it, marks it as an indicator list
 * (indicators of compromise, IOCs, appendix, malicious). A package column is
 * read only when the header or that context names exactly one registry, npm
 * or PyPI; a name with no registry stated is left alone. A row that calls its
 * file a decoy, legitimate, benign or clean is skipped, and so is a table whose
 * label says so.
 */

const PACKAGE_HEADER = /^(?:(npm|pypi)[ _-]*)?package(?:[ _-]*names?)?s?$|^(npm|pypi)$/i;
const HASH_HEADER = /^(?:sha-?(?:1|256|512)|md-?5)(?:[ _-]*(?:hash|digest|sum))?$|^(?:file[ _-]*)?hash(?:es)?$/i;
const INDICATOR_CONTEXT = /indicators?\s+of\s+compromise|\biocs?\b|\bappendix\b|malicious|malware/i;
const HEADINGS_ABOVE = 3;
// A row or label saying the file is a decoy or a legitimate one: a lure
// document can be a victim's own file, and a side-loading host is the vendor's.
const NOT_MALICIOUS = /\b(?:decoys?|legitimate|benign|clean)\b/i;

function registryOf(text) {
  const npm = /\bnpm\b/i.test(text);
  const pypi = /\bpypi\b/i.test(text);
  if (npm === pypi) return null;
  return npm ? "npm_package" : "pypi_package";
}

function rowsOf(tableHtml, cellText) {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((cell) => cellText(cell[2]).replace(/\s+/g, " ").trim())
  );
}

/**
 * The typed cells of every qualifying table in one HTML segment.
 * `headings` are the labels of the headings above the segment, nearest last;
 * `cellText` turns a cell's inner HTML into text the way the page text is
 * built (entities decoded, defanged). Returns [{ ioc_type, value, context, section }].
 */
function readHeaderTables(segmentHtml, headings, cellText) {
  const out = [];
  const above = headings.slice(-HEADINGS_ABOVE);
  const section = above.length ? above[above.length - 1] : null;
  let from = 0;
  for (const table of segmentHtml.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const before = cellText(segmentHtml.slice(from, table.index)).split("\n").map((l) => l.trim()).filter(Boolean);
    from = table.index + table[0].length;
    const label = before.length ? before[before.length - 1] : "";
    const rows = rowsOf(table[0], cellText).filter((r) => r.length);
    if (rows.length < 2) continue;
    const context = [...above, label].join("\n");
    if (!INDICATOR_CONTEXT.test(context) || NOT_MALICIOUS.test(label)) continue;

    const header = rows[0];
    const columns = header.map((name) => {
      const pkg = name.match(PACKAGE_HEADER);
      if (pkg) {
        const named = (pkg[1] || pkg[2] || "").toLowerCase();
        if (named) return named === "npm" ? "npm_package" : "pypi_package";
        return registryOf([section || "", label].join("\n")) || registryOf(context);
      }
      return HASH_HEADER.test(name) ? "file_hash" : null;
    });
    if (!columns.some(Boolean)) continue;

    for (const row of rows.slice(1)) {
      if (row.join("|") === header.join("|") || NOT_MALICIOUS.test(row.join(" "))) continue;
      const quote = `${label ? `${label} ` : ""}${row.join(" | ")}`.slice(0, 300);
      row.forEach((cell, i) => {
        if (columns[i] && cell && !/\s/.test(cell)) out.push({ ioc_type: columns[i], value: cell, context: quote, section });
      });
    }
  }
  return out;
}

/** A PyPI project name as PEP 508 allows it, lower-cased; null when it is not one. */
function normalizePypiPackage(raw) {
  const name = String(raw || "").trim();
  return /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i.test(name) ? name.toLowerCase() : null;
}

module.exports = { readHeaderTables, normalizePypiPackage };
