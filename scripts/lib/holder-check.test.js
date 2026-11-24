const test = require("node:test");
const assert = require("node:assert");
const { signals, score } = require("./holder-check.js");

const NOW = Date.parse("2026-11-23T00:00:00Z");

test("an established developer collects signals and a high score", () => {
  const sig = signals(
    { created_at: "2014-04-14T00:00:00Z", followers: 50, public_repos: 101, company: "NadyLabs", blog: "x.dev", name: "Dwi Saputra" },
    { first: "2018-03-18", last: "2026-10-22" },
    NOW
  );
  assert.strictEqual(sig.length, 7);
  assert.strictEqual(score(sig), 8);
});

test("a fresh persona-like account collects none", () => {
  const sig = signals({ created_at: "2025-06-01T00:00:00Z", followers: 3, public_repos: 4, company: null, blog: "", name: "devstar0914" }, { first: "2025-07-01", last: "2025-09-01" }, NOW);
  assert.deepStrictEqual(sig, []);
  assert.strictEqual(score(sig), 0);
});

test("no profile, no signals", () => {
  assert.deepStrictEqual(signals(null, null, NOW), []);
});
