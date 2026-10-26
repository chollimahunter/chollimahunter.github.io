"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rotationTimeline } = require("../check-etherhiding-contracts.js");

const tx = (to, t, hash) => ({ to, timeStamp: String(t), hash });

test("a NullReceiver write decodes to its repeated IP", () => {
  const [run] = rotationTimeline([tx("0xa658863ea658863e68656c6c6f6970626f742121", 1759900000, "0x1")]);
  assert.equal(run.resolved_ip, "166.88.134.62");
  assert.equal(run.resolved_ips, undefined);
});

test("an XCTDH IP-port-IP-port write decodes to both IPs", () => {
  const [run] = rotationTimeline([tx("0x67d5f82d01bb880007e7005000ff5c60b6c34b5a", 1759900000, "0x1")]);
  assert.equal(run.resolved_ip, "103.213.248.45");
  assert.deepEqual(run.resolved_ips, ["103.213.248.45", "136.0.7.231"]);
});

test("an XCTDH write with the same IP twice decodes to one IP", () => {
  const [run] = rotationTimeline([tx("0x171b14bb0050171b14bb01bb398eaab6441fbd47", 1759900000, "0x1")]);
  assert.equal(run.resolved_ip, "23.27.20.187");
  assert.equal(run.resolved_ips, undefined);
});

test("an ordinary address decodes to nothing", () => {
  const [run] = rotationTimeline([tx("0x596dcc9fda875309ff85eba09cf5a97d8c7691bb", 1759900000, "0x1")]);
  assert.equal(run.resolved_ip, null);
});

test("consecutive writes to the same recipient form one run, and the newest run is last", () => {
  const runs = rotationTimeline([
    tx("0xa658863ea658863e68656c6c6f6970626f742121", 1759800000, "0xa"),
    tx("0xa658863ea658863e68656c6c6f6970626f742121", 1759810000, "0xb"),
    tx("0x67d5f82d01bb880007e7005000ff5c60b6c34b5a", 1759900000, "0xc"),
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].count, 2);
  assert.equal(runs[0].last_tx, "0xb");
  assert.equal(runs[1].last_tx, "0xc");
});
