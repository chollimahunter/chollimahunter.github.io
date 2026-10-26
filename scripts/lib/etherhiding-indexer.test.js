"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { enumerateTransactions } = require("../check-etherhiding-contracts.js");

const ADDRESS = "0x9268cc33d59415b033dc5d709ce30bbe09708fe3";

test("txlist asks for a full page, and a full page falls through to the next indexer", async () => {
  const realFetch = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    asked.push(new URL(url));
    const full = asked.length === 1;
    const result = Array.from({ length: full ? 10000 : 38 }, (_, i) => ({ hash: `0x${i}` }));
    return { ok: true, status: 200, json: async () => ({ status: "1", message: "OK", result }) };
  };
  try {
    const list = await enumerateTransactions(["https://first.example/api", "https://second.example/api"], null, ADDRESS);
    assert.equal(list.length, 38);
    assert.equal(asked.length, 2);
    for (const url of asked) {
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("offset"), "10000");
    }
    assert.equal(asked[1].host, "second.example");
  } finally {
    global.fetch = realFetch;
  }
});

test("a throttled indexer hands the call on at once and is tried last for the rest of the run", async () => {
  const realFetch = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const host = new URL(url).host;
    asked.push(host);
    if (host === "busy.example") return { ok: false, status: 429, statusText: "Too Many Requests", json: async () => null };
    return { ok: true, status: 200, json: async () => ({ status: "1", message: "OK", result: [{ hash: "0x1" }] }) };
  };
  const indexers = ["https://busy.example/api", "https://calm.example/api"];
  try {
    const started = Date.now();
    assert.equal((await enumerateTransactions(indexers, null, ADDRESS)).length, 1);
    assert.ok(Date.now() - started < 5000, "no backoff before failing over");
    assert.deepEqual(asked, ["busy.example", "calm.example"]);
    asked.length = 0;
    assert.equal((await enumerateTransactions(indexers, null, ADDRESS)).length, 1);
    assert.deepEqual(asked, ["calm.example"]);
  } finally {
    global.fetch = realFetch;
  }
});
