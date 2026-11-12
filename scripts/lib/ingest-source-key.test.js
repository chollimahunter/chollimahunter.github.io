/**
 * ingest-source-key.test.js — table-driven tests for the sighting identity in
 * scripts/ingest-scraped-iocs.js
 * ==========================================================================
 * Two reads of one passage whose stored quote windows differ (a page footer
 * changed, an extractor cut a few characters further) are one citation; two
 * different passages of one page that quote the same indicator stay two. Run
 * with `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sourceKey, passageCore } = require("../ingest-scraped-iocs.js");

const URL = "https://quetzal.bitso.com/p/interview-with-the-chollima-vi";
const record = { ioc_type: "linkedin_profile", value: "https://www.linkedin.com/in/jesus-sebastian/", display: null };
const lead = "…a long enough run of article prose to fill the window before it. Public IOCs URL:https://linkedin.com/in/jesus-sebastian/ ";
const a = lead + "3 Share Previous Next Top Latest No posts Ready for more? Subscribe © 2026 Bitso ·…";
const b = lead + "3 Share Previous Next Top Latest Discussions No posts Ready for more? Subscribe © 2026…";

const cases = [
  ["a changed footer past the window is the same sighting", a, b, true],
  ["whitespace and case inside the window are folded", a, a.replace("Public IOCs", "public   iocs"), true],
  [
    "different prose before the indicator is a different sighting",
    a,
    "…an entirely different paragraph that also happens to name the account: URL:https://linkedin.com/in/jesus-sebastian/ 3 Share Previous Next Top Latest No posts",
    false,
  ],
];

for (const [name, first, second, same] of cases) {
  test(name, () => {
    const k1 = sourceKey({ url: URL, context: first }, record);
    const k2 = sourceKey({ url: URL, context: second }, record);
    assert.equal(k1 === k2, same);
  });
}

test("another URL is never the same sighting", () => {
  assert.notEqual(sourceKey({ url: URL, context: a }, record), sourceKey({ url: URL + "/", context: a }, record));
});

test("an indicator too near the edge of the quote falls back to the whole quote", () => {
  assert.equal(passageCore("URL:https://linkedin.com/in/jesus-sebastian/ and more text after it that runs on", record), null);
  const k1 = sourceKey({ url: URL, context: "jesus-sebastian/ short A" }, record);
  const k2 = sourceKey({ url: URL, context: "jesus-sebastian/ short B" }, record);
  assert.notEqual(k1, k2);
});

test("a redacted quote is compared whole", () => {
  const k1 = sourceKey({ url: URL, context: a, context_origin: "redacted" }, record);
  const k2 = sourceKey({ url: URL, context: b, context_origin: "redacted" }, record);
  assert.notEqual(k1, k2);
});

test("without a record the whole quote is compared, as before", () => {
  assert.notEqual(sourceKey({ url: URL, context: a }), sourceKey({ url: URL, context: b }));
});
