"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { gateDecision } = require("./etherhiding-review-gate.js");

const wallet = {
  id: "resolver-1", target: "0xaa", kind: "eoa", chain: "ethereum", block: 1, nonce: 5, balance_wei: "0",
  rotation: [{ to: "0xa658863ea658863e68656c6c6f6970626f742121", resolved_ip: "166.88.134.62", from: "2026-09-01", until: "2026-09-02", count: 3, first_tx: "0x1", last_tx: "0x3" }],
};
const contract = {
  id: "contract-1", target: "0xbb", kind: "contract", chain: "ethereum", block: 1, code_sha256: "c1",
  mapping: [{ operator: "0xop", value: "https://a.example" }], mapping_writes: 1,
  mapping_history: [{ from: "0xop", value: "https://a.example", since: "2026-09-01", tx: "0xw1" }],
};
const base = (o) => ({ scan_id: "s", ran_at: "t", ruleset_version: "r1", matches: [], changes: [], queries_executed: ["ok"], status_note: "n", observations: o });
const previous = base([wallet, contract]);
const clone = (x) => JSON.parse(JSON.stringify(x));

test("an unchanged run merges with nothing to review", () => {
  const d = gateDecision(base([wallet, contract]), previous);
  assert.equal(d.needsReview, false, d.reasons.join("; "));
  assert.equal(d.fresh.length, 0);
});

test("a nonce advance and an extended rotation run merge with nothing new", () => {
  const w = clone(wallet); w.nonce = 9; w.block = 2; w.rotation[0].until = "2026-09-05"; w.rotation[0].count = 7; w.rotation[0].last_tx = "0x9";
  const d = gateDecision(base([w, contract]), previous);
  assert.equal(d.needsReview, false, d.reasons.join("; "));
  assert.equal(d.fresh.length, 0);
});

test("a new rotation, a new C2 string and a new write merge and are listed for review", () => {
  const w = clone(wallet);
  w.rotation.push({ to: "0x67d5f82d01bb880007e7005000ff5c60b6c34b5a", resolved_ip: "103.213.248.45", resolved_ips: ["103.213.248.45", "136.0.7.231"], from: "2026-10-07", until: "2026-10-08", count: 2, first_tx: "0x10", last_tx: "0x11" });
  const c = clone(contract);
  c.mapping[0].value = "https://b.example"; c.mapping_writes = 2;
  c.mapping_history.push({ from: "0xop", value: "https://b.example", since: "2026-10-08", tx: "0xw2" });
  const d = gateDecision(base([w, c]), previous);
  assert.equal(d.needsReview, false, d.reasons.join("; "));
  assert.equal(d.fresh.length, 3);
  assert.match(d.fresh.join(" "), /136\.0\.7\.231/);
  assert.match(d.fresh.join(" "), /b\.example/);
});

test("replaced bytecode merges and is listed", () => {
  const c = clone(contract); c.code_sha256 = "c2";
  const d = gateDecision(base([wallet, c]), previous);
  assert.equal(d.needsReview, false);
  assert.match(d.fresh.join(" "), /bytecode replaced/);
});

test("without a previous file the run holds", () => {
  assert.equal(gateDecision(base([wallet]), null).needsReview, true);
});

test("data loss holds: a vanished observation, rotation, run, write, operator or code", () => {
  const cases = [];
  cases.push(base([contract]));
  { const w = clone(wallet); delete w.rotation; cases.push(base([w, contract])); }
  { const w = clone(wallet); w.rotation[0].to = "0xdifferent"; cases.push(base([w, contract])); }
  { const c = clone(contract); c.mapping_history = []; cases.push(base([wallet, c])); }
  { const c = clone(contract); c.mapping = []; cases.push(base([wallet, c])); }
  { const c = clone(contract); delete c.code_sha256; cases.push(base([wallet, c])); }
  { const w = clone(wallet); w.nonce = 4; cases.push(base([w, contract])); }
  for (const [i, latest] of cases.entries()) assert.equal(gateDecision(latest, previous).needsReview, true, `case ${i}`);
});

test("a watchlist edit may remove an observation", () => {
  const latest = base([contract]); latest.ruleset_version = "r2";
  assert.equal(gateDecision(latest, previous).needsReview, false);
});

test("a degraded run holds", () => {
  const latest = base([wallet, contract]);
  latest.queries_executed = Array.from({ length: 20 }, (_, i) => (i < 2 ? "x -- FAILED: timeout" : "ok"));
  assert.equal(gateDecision(latest, previous).needsReview, true);
});

test("unknown fields, keys and change types hold", () => {
  { const w = clone(wallet); w.brand_new = 1; assert.equal(gateDecision(base([w, contract]), previous).needsReview, true); }
  { const l = base([wallet, contract]); l.new_section = {}; assert.equal(gateDecision(l, previous).needsReview, true); }
  { const l = base([wallet, contract]); l.changes = [{ change: "payload removed", chain: "ethereum", target: "0xbb" }]; assert.equal(gateDecision(l, previous).needsReview, true); }
});

test("a new observation needs a watchlist entry behind it", () => {
  const stray = { ...clone(wallet), id: null, target: "0xcc" };
  assert.equal(gateDecision(base([wallet, contract, stray]), previous).needsReview, true);
  const listed = { ...clone(wallet), id: "resolver-2", target: "0xdd" };
  const d = gateDecision(base([wallet, contract, listed]), previous);
  assert.equal(d.needsReview, false);
  assert.match(d.fresh.join(" "), /first observed/);
});
