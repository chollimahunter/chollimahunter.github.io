/**
 * ioc-index.test.js — the merge, fold, labelling and CSV helpers in
 * src/_data/iocIndex.js, and the malformed-escape guard in the normalizers.
 * Run with `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeRecords, foldDuplicateTypes, toCsv, typeLabel } = require("../../src/_data/iocIndex.js");
const { recordId, normalizeGithub, normalizeLinkedin, PLATFORM_ACCOUNTS, normalizePlatformAccount } = require("./ioc-normalize.js");

const record = (type, value, url, extra = {}) => ({
  id: recordId(type, value),
  ioc_type: type,
  value,
  campaign: [],
  first_seen: "2026-01-01",
  last_seen: "2026-01-01",
  extraction: { method: "regex", model: null, grounded: true },
  sources: [{ url, context: "c", pulled_at: "2026-01-02" }],
  ...extra,
});

test("recordId is stable for a type and value", () => {
  assert.equal(recordId("domain", "blocknovas.com"), recordId("domain", "blocknovas.com"));
  assert.notEqual(recordId("domain", "blocknovas.com"), recordId("hosted_site", "blocknovas.com"));
});

test("mergeRecords merges citations onto one record and keeps its id", () => {
  const a = record("domain", "x.example", "https://a.example/1");
  const b = record("domain", "x.example", "https://b.example/2", { first_seen: "2025-06-01" });
  const [merged] = mergeRecords([a], [b, a]);
  assert.equal(merged.id, a.id);
  assert.deepEqual(merged.sources.map((s) => s.url), ["https://a.example/1", "https://b.example/2"]);
  assert.equal(merged.first_seen, "2025-06-01");
});

test("foldDuplicateTypes merges a hosted_site into the domain for the same host", () => {
  const domain = record("domain", "0927.vercel.app", "https://ruleset.example/");
  const hosted = record("hosted_site", "0927.vercel.app", "https://report.example/");
  const other = record("hosted_site", "other.vercel.app", "https://report.example/");
  const { records, redirects } = foldDuplicateTypes(mergeRecords([domain, hosted, other]));
  assert.deepEqual(records.map((r) => r.id), [domain.id, other.id]);
  assert.equal(records[0].sources.length, 2);
  assert.deepEqual(redirects, [{ from: hosted.id, to: domain.id }]);
});

test("typeLabel reads the article from the sound, not the letter", () => {
  for (const [type, article] of [
    ["email_address", "an"],
    ["upwork_account", "a"],
    ["useme_account", "a"],
    ["username", "a"],
    ["npm_package", "an"],
    ["x_account", "an"],
    ["github_profile", "a"],
    ["wantedly_account", "a"],
  ]) {
    assert.equal(typeLabel(type).article, article, type);
  }
  assert.equal(typeLabel("balkanfreelance_account").label, "BalkanFreelance account");
});

test("toCsv guards cells a spreadsheet would read as a formula", () => {
  const row = (value) =>
    toCsv([{ value, ioc_type: "t", campaign: [], extraction: { method: "regex" }, sources: [] }]).split("\n")[1].split(",")[0];
  for (const [input, expected] of [
    ["=HYPERLINK(1)", "'=HYPERLINK(1)"],
    ["@SUM(1)", "'@SUM(1)"],
    ["-cmd|x", "'-cmd|x"],
    ["+12025550123", "+12025550123"],
    ["-5", "-5"],
    ["plain", "plain"],
  ]) {
    assert.equal(row(input), expected, input);
  }
});

test("normalizers do not throw on a malformed percent-escape", () => {
  assert.doesNotThrow(() => normalizeGithub("https://github.com/foo%zz"));
  assert.equal(normalizeGithub("https://github.com/foo%zz"), null);
  assert.doesNotThrow(() => normalizeLinkedin("https://www.linkedin.com/in/foo%zz"));
  const telegram = normalizePlatformAccount(PLATFORM_ACCOUNTS.find((s) => s.ioc_type === "telegram_account"));
  assert.doesNotThrow(() => telegram("https://t.me/foo%zz"));
});

test("the search file keeps a type or method index of 0", () => {
  const { searchCore } = require("../../src/_data/iocIndex.js");
  const core = searchCore({
    v: 2,
    types: ["alias", "email_address"],
    methods: ["curated"],
    sources: [],
    contexts: [],
    records: [{ i: "a", t: 0, v: "x", e: 0, g: 0, d: null, r: "remote-workers", k: [], s: [] }],
  });
  const record = core.records[0];
  assert.equal(record.t, 0);
  assert.equal(record.e, 0);
  assert.equal("g" in record, false);
  assert.equal("d" in record, false);
});
