"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readHeaderTables, normalizePypiPackage } = require("./header-tables.js");
const { resolveStreamedHtml } = require("./streamed-html.js");

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
const table = (head, ...rows) =>
  `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</table>`;
const SHA1 = "85355c1b0c8674dddb6d703d90c00190c18ca4c0";

test("a package table under an IOC heading takes its registry from the heading above it", () => {
  const html = table(["package_name", "version", "SHA1"], ["log-upgrade", "7.1.0", SHA1], ["@tsjunk/chalk", "5.6.2", SHA1]);
  const cells = readHeaderTables(html, ["Indicators of Compromise (IOCs)", "npm packages:"], text);
  assert.deepEqual(
    cells.map((c) => `${c.ioc_type} ${c.value}`),
    [`npm_package log-upgrade`, `file_hash ${SHA1}`, `npm_package @tsjunk/chalk`, `file_hash ${SHA1}`]
  );
  assert.equal(cells[0].section, "npm packages:");
  assert.equal(cells[0].context, `log-upgrade | 7.1.0 | ${SHA1}`);
});

test("the label line just before a table names the registry when no heading does", () => {
  const html = `<p>IOCs</p><p>PyPI package:</p>${table(["package_name", "version"], ["scraper-npm", "1.0.4"])}`;
  const cells = readHeaderTables(html, ["Analysis"], text);
  assert.deepEqual(cells.map((c) => `${c.ioc_type} ${c.value}`), ["pypi_package scraper-npm"]);
});

test("a header that names the registry needs no label", () => {
  const html = table(["npm package", "notes"], ["evil-pkg", "malicious"]);
  assert.deepEqual(readHeaderTables(html, ["Appendix"], text).map((c) => c.ioc_type), ["npm_package"]);
});

test("nothing is read outside an indicator section, or when the registry is unstated or ambiguous", () => {
  const html = table(["package_name", "SHA256"], ["left-pad", "a".repeat(64)]);
  assert.deepEqual(readHeaderTables(html, ["Popular npm packages"], text), []);
  assert.deepEqual(
    readHeaderTables(html, ["Indicators of compromise"], text).map((c) => c.ioc_type),
    ["file_hash"],
    "no registry named: the hash column is read, the package column is not"
  );
  assert.deepEqual(
    readHeaderTables(html, ["IOCs", "npm and PyPI packages"], text).map((c) => c.ioc_type),
    ["file_hash"]
  );
});

test("a table with no typed header column yields nothing", () => {
  const html = table(["Name", "Role"], ["dprk-dev", "operator"]);
  assert.deepEqual(readHeaderTables(html, ["IOCs"], text), []);
});

test("PyPI names are validated and lower-cased", () => {
  assert.equal(normalizePypiPackage("Scraper-NPM"), "scraper-npm");
  assert.equal(normalizePypiPackage("bad name"), null);
  assert.equal(normalizePypiPackage("-x"), null);
});

test("streamed chunks are moved into their placeholders, nested ones too", () => {
  const html =
    `<table><tr><td>a</td><template id="P:1"></template></tr></table>` +
    `<div hidden id="S:2"><b>2</b></div><script>$RS("S:2","P:2")</script>` +
    `<table hidden><tr id="S:1"><td>b<template id="P:2"></template></td></tr></table><script>$RS("S:1","P:1")</script>`;
  assert.equal(resolveStreamedHtml(html), `<table><tr><td>a</td><td>b<b>2</b></td></tr></table>`);
  assert.equal(resolveStreamedHtml("<p>plain</p>"), "<p>plain</p>");
});
