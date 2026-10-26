"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { tronWrite, aptosWrite, pointerRotation, readTronWrites, readAptosWrites, readPointers, keepPrunedRuns } = require("./etherhiding-pointers.js");
const { gateDecision } = require("./etherhiding-review-gate.js");

const H1 = "0x" + "a1".repeat(32);
const H2 = "0x" + "b2".repeat(32);
const tronData = (hash) => Buffer.from(hash.split("").reverse().join(""), "utf8").toString("hex");
const tronTx = (hash, ms, id) => ({ txID: id, block_timestamp: ms, raw_data: { data: hash === null ? undefined : tronData(hash) } });
const aptosTx = (hash, us, id, seq) => ({ hash: id, timestamp: String(us), sequence_number: String(seq), payload: { arguments: [hash] } });
const DAY1 = Date.UTC(2026, 9, 5, 12);
const DAY2 = Date.UTC(2026, 9, 7, 12);
const noDelay = async () => {};
const respond = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test("a TRON transaction whose memo is a reversed BSC hash is a pointer write", () => {
  const cases = [
    [tronTx(H1, DAY1, "t1"), { day: "2026-10-05", bsc: H1, tx: "t1" }],
    [tronTx(H1.toUpperCase().replace("0X", "0x"), DAY2, "t2"), { day: "2026-10-07", bsc: H1, tx: "t2" }],
    [tronTx("Mxy Custom Memo Text", DAY1, "t3"), null],
    [tronTx(null, DAY1, "t4"), null],
    [{ txID: "t5", block_timestamp: DAY1, raw_data: { data: "zz" } }, null],
    [{ txID: "t6", raw_data: { data: tronData(H1) } }, null],
  ];
  for (const [tx, want] of cases) {
    const got = tronWrite(tx);
    if (want === null) assert.equal(got, null, tx.txID);
    else assert.deepEqual({ day: got.day, bsc: got.bsc, tx: got.tx }, want, tx.txID);
  }
});

test("an Aptos transaction whose first argument is a BSC hash is a pointer write", () => {
  const cases = [
    [aptosTx(H2, DAY1 * 1000, "a1", 0), { day: "2026-10-05", bsc: H2, tx: "a1" }],
    [aptosTx("0x1234", DAY1 * 1000, "a2", 1), null],
    [{ hash: "a3", timestamp: String(DAY1 * 1000), payload: {} }, null],
    [{ hash: "a4", timestamp: "x", payload: { arguments: [H2] } }, null],
  ];
  for (const [tx, want] of cases) {
    const got = aptosWrite(tx);
    if (want === null) assert.equal(got, null, tx.hash);
    else assert.deepEqual({ day: got.day, bsc: got.bsc, tx: got.tx }, want, tx.hash);
  }
});

test("writes naming the same BSC transaction form one run, oldest first whatever the input order", () => {
  const w = (bsc, ms, tx) => tronWrite(tronTx(bsc, ms, tx));
  const runs = pointerRotation([w(H2, DAY2, "c"), w(H1, DAY1, "a"), w(H1, DAY1 + 3600000, "b")]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { to: H1, resolved_ip: null, label: null, from: "2026-10-05", until: "2026-10-05", count: 2, first_tx: "a", last_tx: "b" });
  assert.equal(runs[1].to, H2);
  assert.equal(runs[1].first_tx, "c");
  assert.deepEqual(pointerRotation([]), []);
});

test("TRON paging follows the next link only on the TronGrid host", async () => {
  const seen = [];
  const pages = [
    { data: [tronTx(H2, DAY2, "b")], meta: { links: { next: "https://api.trongrid.io/v1/page2" } } },
    { data: [tronTx(H1, DAY1, "a")], meta: { links: { next: "https://evil.example/steal" } } },
  ];
  const fetchFn = async (url) => { seen.push(url); return respond(pages[seen.length - 1]); };
  const writes = await readTronWrites("TXexample", { fetchFn, delay: noDelay });
  assert.equal(writes.length, 2);
  assert.equal(seen.length, 2);
  assert.ok(seen[1].startsWith("https://api.trongrid.io/"));
});

test("Aptos paging continues from the last sequence number until a short page", async () => {
  const full = Array.from({ length: 100 }, (_, i) => aptosTx(H1, DAY1 * 1000, `a${i}`, i));
  const seen = [];
  const fetchFn = async (url) => { seen.push(url); return respond(seen.length === 1 ? full : [aptosTx(H2, DAY2 * 1000, "last", 100)]); };
  const writes = await readAptosWrites("0xabc", { fetchFn, delay: noDelay });
  assert.equal(writes.length, 101);
  assert.match(seen[1], /start=100$/);
});

test("a failed pointer read is reported as FAILED and leaves the observation without a rotation", async () => {
  const entries = [
    { id: "p-tron", ioc_type: "wallet_address", chain: "tron", onchain_role: "pointer_wallet", value: "TXexample" },
    { id: "p-aptos", ioc_type: "wallet_address", chain: "aptos", onchain_role: "pointer_account", value: "0xabc" },
    { id: "evm", ioc_type: "wallet_address", chain: "bsc", value: "0x" + "1".repeat(40) },
  ];
  const fetchFn = async (url) => (url.includes("trongrid") ? respond({}, false, 429) : respond([aptosTx(H1, DAY1 * 1000, "a", 0)]));
  const { observations, queries } = await readPointers(entries, { fetchFn, delay: noDelay });
  assert.equal(observations.length, 2);
  assert.equal(observations[0].rotation, undefined);
  assert.equal(observations[1].rotation.length, 1);
  assert.match(queries[0], / -- FAILED: HTTP 429$/);
  assert.doesNotMatch(queries[1], /FAILED/);
});

test("the review gate reports a new pointer write as a new value and does not hold the run", () => {
  const obs = (rotation) => ({ id: "p", target: "TXexample", kind: "pointer", chain: "tron", rotation });
  const run = (to, from, count, first, last) => ({ to, resolved_ip: null, label: null, from, until: from, count, first_tx: first, last_tx: last });
  const before = { ruleset_version: "v", changes: [], queries_executed: [], observations: [obs([run(H1, "2026-10-05", 1, "a", "a")])] };
  const after = { ...before, observations: [obs([run(H1, "2026-10-05", 1, "a", "a"), run(H2, "2026-10-07", 1, "b", "b")])] };
  const decision = gateDecision(after, before);
  assert.equal(decision.needsReview, false);
  assert.equal(decision.fresh.length, 1);
  assert.match(decision.fresh[0], new RegExp(`tron:txexample now points at ${H2}`));
});

test("runs the Aptos ledger has pruned are kept from the previous refresh", () => {
  const H3 = "0x" + "c3".repeat(32);
  const run = (to, from, until, count, first, last) => ({ to, resolved_ip: null, label: null, from, until, count, first_tx: first, last_tx: last });
  const obs = (rotation) => ({ id: "p", target: "0xabc", kind: "pointer", chain: "aptos", rotation });
  const previous = [obs([run(H1, "2026-10-05", "2026-10-05", 1, "a", "a"), run(H2, "2026-10-07", "2026-10-07", 1, "b", "b")])];
  const current = [obs([run(H2, "2026-10-07", "2026-10-07", 1, "b", "b"), run(H3, "2026-10-17", "2026-10-17", 1, "c", "c")])];
  keepPrunedRuns(previous, current);
  assert.deepEqual(current[0].rotation.map((r) => r.first_tx), ["a", "b", "c"]);

  // A run the window cut through keeps its original start and count.
  const cutBefore = [obs([run(H1, "2026-10-05", "2026-10-08", 3, "a", "c")])];
  const cutNow = [obs([run(H1, "2026-10-07", "2026-10-08", 2, "b", "c")])];
  keepPrunedRuns(cutBefore, cutNow);
  assert.deepEqual(cutNow[0].rotation, [run(H1, "2026-10-05", "2026-10-08", 3, "a", "c")]);

  // Everything pruned: the previous timeline stands.
  const gone = [obs([])];
  keepPrunedRuns(previous, gone);
  assert.equal(gone[0].rotation.length, 2);

  // A failed read (no rotation) is left to carryForwardHistory.
  const failed = [{ id: "p", target: "0xabc", kind: "pointer", chain: "aptos" }];
  keepPrunedRuns(previous, failed);
  assert.equal(failed[0].rotation, undefined);
});
