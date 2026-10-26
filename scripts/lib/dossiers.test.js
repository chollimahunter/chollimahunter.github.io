/**
 * dossiers.test.js — the `post` field of a dossier indicator, and the
 * malformed-escape guard on account URLs. Run with `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { recordsFromDossiers } = require("./dossiers.js");
const { safeDecode } = require("./ioc-normalize.js");

const config = (post) => ({
  researchers: { r: { publisher: "Researcher", account: "https://x.com/r" } },
  dossiers: [
    {
      persona: "Test Persona",
      researcher: "r",
      posts: [
        { url: "https://example.com/own", date: "2026-09-20" },
        { url: "https://example.com/report", date: "2026-08-01" },
      ],
      indicators: [{ ioc_type: "email_address", value: "someone@example.com", post }],
    },
  ],
});

const emailRecord = (post) =>
  recordsFromDossiers(config(post)).find((r) => r.ioc_type === "email_address");

test("post as a number or omitted cites one post, as before", () => {
  for (const [label, post, url] of [
    ["omitted", undefined, "https://example.com/own"],
    ["zero", 0, "https://example.com/own"],
    ["one", 1, "https://example.com/report"],
    ["out of range falls back to the first", 5, "https://example.com/own"],
  ]) {
    const record = emailRecord(post);
    assert.deepEqual(record.sources.map((s) => s.url), [url], label);
  }
});

test("post as a list cites each listed post, in order, on one record", () => {
  const record = emailRecord([0, 1]);
  assert.deepEqual(record.sources.map((s) => s.url), ["https://example.com/own", "https://example.com/report"]);
  assert.equal(record.first_seen, "2026-08-01");
  assert.equal(record.last_seen, "2026-09-20");
});

test("a list naming a post the entry does not have stops the build", () => {
  assert.throws(() => emailRecord([0, 2]), /Test Persona.*someone@example\.com.*cites post 2/);
  assert.throws(() => emailRecord([]), /empty post list/);
});

test("safeDecode returns a malformed segment as written", () => {
  for (const [input, expected] of [
    ["foo%zz", "foo%zz"],
    ["caf%C3%A9", "café"],
    ["%E0%A4%A", "%E0%A4%A"],
    ["plain", "plain"],
  ]) {
    assert.equal(safeDecode(input), expected);
  }
});
