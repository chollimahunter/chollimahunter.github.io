// Tests for candidate-confidence.js: the screening confidence a candidate row
// is given from its matched signals.
const test = require("node:test");
const assert = require("node:assert/strict");
const { candidateConfidence, candidateSignals } = require("./candidate-confidence.js");

test("candidateConfidence scores a row's signals into high, medium or low", () => {
  const cases = [
    // [signals, expected, why]
    [["marketplace-resume"], "low", "a marketplace CV alone"],
    [["marketplace-resume", "voip-number"], "medium", "one strong sign"],
    [["name-mismatch"], "low", "an established account under another name is the stolen identity"],
    [["name-mismatch", "recent-account"], "high", "a new account under another name"],
    [["voip-number", "photo-name-mismatch", "recent-account"], "high", "two strong signs and a supporting one"],
    [["recent-account", "seniority-against-empty-network", "employment-gap", "sparse-history"], "medium", "weak signs never reach high"],
    [["role-title", "open-to-work", "keyword-stuffed-headline", "no-profile-photo"], "low", "ordinary job-seeker signs score nothing"],
    [["shared-claimed-employer", "employment-predates-account", "seniority-against-empty-network"], "high", "a shared employer is a link"],
  ];
  for (const [signals, expected, why] of cases) {
    assert.equal(candidateConfidence(signals), expected, why);
  }
});

test("candidateSignals adds VoIP from the line type and corroboration from cited sources", () => {
  const row = { matched_indicators: ["marketplace-resume"], facts: { line_type: "VoIP" }, corroboration: [{ url: "https://example.org" }] };
  const signals = candidateSignals(row);
  assert.ok(signals.includes("voip-number"));
  assert.ok(signals.includes("corroborated"));
  assert.equal(candidateConfidence(signals), "high");
});
