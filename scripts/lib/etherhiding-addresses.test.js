/**
 * etherhiding-addresses.test.js — how C2 hosts are tied to watchlisted
 * addresses for the /etherhiding/ address table. Run with
 * `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { addressRows, onChainLinks, hostOf } = require("./etherhiding-addresses.js");

const CONTRACT = "0x00000000000000000000000000000000000000c1";
const OPERATOR = "0x00000000000000000000000000000000000000a1";
const RESOLVER = "0x00000000000000000000000000000000000000b1";
const IDLE = "0x00000000000000000000000000000000000000d1";

const watchlist = [
  { id: "contract", ioc_type: "smart_contract_address", value: CONTRACT, confidence_level: "medium" },
  { id: "operator", ioc_type: "wallet_address", value: OPERATOR, confidence_level: "medium" },
  { id: "resolver", ioc_type: "wallet_address", value: RESOLVER, confidence_level: "medium" },
  { id: "idle", ioc_type: "wallet_address", value: IDLE.toUpperCase().replace("0X", "0x"), confidence_level: "low" },
  { id: "c2-old", ioc_type: "domain", value: "old.example", description: "written to the contract" },
  { id: "c2-named", ioc_type: "ip_address", value: "192.0.2.9", description: `served by ${IDLE} in a report` },
];

const findings = {
  ran_at: "2026-10-04T12:00:00Z",
  observations: [
    {
      target: CONTRACT,
      kind: "contract",
      mapping: [{ operator: OPERATOR, value: "https://new.example" }],
      mapping_history: [
        { from: OPERATOR, value: "https://old.example", since: "2026-01-01", until: "2026-01-03" },
        { from: OPERATOR, value: "http://localhost:3000", since: "2026-01-05", until: "2026-01-05" },
        { from: OPERATOR, value: "https://new.example", since: "2026-02-01", until: "2026-02-01" },
      ],
    },
    {
      target: RESOLVER,
      kind: "eoa",
      rotation: [{ resolved_ip: "198.51.100.7", from: "2026-09-01", until: "2026-09-10" }],
    },
  ],
  changes: [
    { target: RESOLVER, change: "operator activity" },
    { target: IDLE, change: "first observation" },
  ],
};

const rows = addressRows(watchlist, findings);
const row = (id) => rows.find((r) => r.id === id);

test("hostOf reads URLs, bare hosts and IPs", () => {
  assert.equal(hostOf("https://Old.Example/path"), "old.example");
  assert.equal(hostOf("http://91.215.85.42:3000"), "91.215.85.42");
  assert.equal(hostOf("198.51.100.7"), "198.51.100.7");
  assert.equal(hostOf(""), null);
});

test("contract history ties each host to the contract and its writer, without placeholders", () => {
  for (const id of ["contract", "operator"]) {
    assert.deepEqual(row(id).c2.map((c) => c.host), ["new.example", "old.example"]);
    assert.equal(row(id).latest_c2.host, "new.example");
    assert.equal(row(id).latest_c2.known, false);
    assert.equal(row(id).last_active, "2026-02-01");
  }
});

test("a resolver wallet gets its rotation IPs and the run date when it moved", () => {
  assert.deepEqual(row("resolver").c2.map((c) => c.host), ["198.51.100.7"]);
  assert.equal(row("resolver").last_active, "2026-10-04");
});

test("a watchlisted host whose description names the address is tied undated", () => {
  assert.deepEqual(row("idle").c2, [{ host: "192.0.2.9", first: null, last: null, first_tx: null, last_tx: null, known: true, indicator_id: null, decoy: null }]);
  assert.equal(row("idle").last_active, null);
});

test("rows sort by when their latest C2 was added, undated last", () => {
  assert.deepEqual(rows.map((r) => r.id), ["resolver", "operator", "contract", "idle"]);
});

test("decodedIps reads NullReceiver and XCTDH recipients and nothing else", () => {
  const { decodedIps } = require("./etherhiding-addresses.js");
  assert.deepEqual(decodedIps("0xa658863ea658863e68656c6c6f6970626f742121"), ["166.88.134.62"]);
  assert.deepEqual(decodedIps("0x171b14bb01bb171b14bb0050eb7f39c35c47e682"), ["23.27.20.187"]);
  assert.deepEqual(decodedIps("0xc6697fd201bb2d89c685005000ff68ce430f572a"), ["198.105.127.210", "45.137.198.133"]);
  assert.deepEqual(decodedIps("0x8eac3198dd72f3e07108c4c7cff43108ad48a71c"), []);
  assert.deepEqual(decodedIps("0xa322e5f3d311d3080e6f0121063e9adc2490ef1a"), []);
  assert.deepEqual(decodedIps("0x0000000000000000000000000000000000000000"), []);
});

test("an encoded recipient and the wallet that paid it both get the decoded IP", () => {
  const signal = "0x00000000000000000000000000000000000000e1";
  const encoded = "0x2d89c68501bb2d89c685005000ffa4fe9c698e98";
  const out = addressRows(
    [
      { id: "signal", ioc_type: "wallet_address", value: signal },
      { id: "encoded", ioc_type: "wallet_address", value: encoded },
    ],
    { observations: [{ target: signal, rotation: [{ to: encoded, resolved_ip: null, from: "2026-10-02", until: "2026-10-04" }] }] }
  );
  for (const r of out) assert.deepEqual(r.c2.map((c) => [c.host, c.first]), [["45.137.198.133", "2026-10-02"]]);
});

test("an owner wallet with nothing of its own takes its contract's hosts", () => {
  const owner = "0x00000000000000000000000000000000000000f1";
  const out = addressRows(
    [
      { id: "jade-contract", ioc_type: "smart_contract_address", value: CONTRACT },
      { id: "jade-owner", ioc_type: "wallet_address", onchain_role: "owner_eoa", value: owner, description: "Owner of jade-contract." },
      { id: "c2", ioc_type: "ip_address", value: "192.0.2.1", description: `served by ${CONTRACT}` },
    ],
    {}
  );
  assert.deepEqual(out.find((r) => r.id === "jade-owner").c2.map((c) => c.host), ["192.0.2.1"]);
});

test("reviewed non-C2 values are kept apart, marked, and never the latest C2", () => {
  const out = addressRows(watchlist, findings, { hosts: { "new.example": { verdict: "parked" } } });
  const contract = out.find((r) => r.id === "contract");
  assert.deepEqual(contract.c2.map((c) => c.host), ["old.example"]);
  assert.equal(contract.latest_c2.host, "old.example");
  assert.deepEqual(contract.decoys.map((c) => [c.host, c.decoy, c.indicator_id]), [["new.example", "parked", null]]);
});

test("a dated tie carries the transactions that wrote it, on the observation's chain", () => {
  const out = addressRows(
    [{ id: "c", ioc_type: "smart_contract_address", value: CONTRACT }],
    {
      observations: [
        {
          target: CONTRACT,
          chain: "bsc",
          mapping_history: [
            { from: OPERATOR, value: "https://a.example", since: "2026-01-02", until: "2026-01-02", tx: "0x02" },
            { from: OPERATOR, value: "https://a.example", since: "2026-01-01", until: "2026-01-01", tx: "0x01" },
          ],
        },
      ],
    },
    {}
  );
  const host = out[0].c2[0];
  assert.deepEqual([host.first, host.first_tx, host.last, host.last_tx], ["2026-01-01", { chain: "bsc", hash: "0x01" }, "2026-01-02", { chain: "bsc", hash: "0x02" }]);
});

test("on-chain links carry network data and keep hosts with no page", () => {
  const rows = [
    {
      indicator_id: "wallet-page",
      value: CONTRACT,
      ioc_type: "wallet_address",
      chain: "ethereum",
      role: "resolver_wallet",
      malware_family: null,
      c2: [
        { host: "192.0.2.1", first: "2026-10-02", last: "2026-10-04", known: true, indicator_id: "ip-page" },
        { host: "198.51.100.7", first: "2026-10-01", last: "2026-10-01", known: false, indicator_id: null },
      ],
    },
  ];
  const records = new Map([["ip-page", { network_status: { label: "data centre", isp: "Example Hosting", asn: "AS64500", country_name: "Iceland" } }]]);
  const links = onChainLinks(rows, records);
  assert.deepEqual(links["wallet-page"].map((l) => [l.value, l.known, l.network && l.network.label]), [
    ["192.0.2.1", true, "data centre"],
    ["198.51.100.7", false, null],
  ]);
  assert.equal(links["ip-page"][0].kind, "wallet");
  assert.equal(links["ip-page"][0].role, "resolver_wallet");
});

test("a pointer's dated c2_history dates the ties its c2_hosts states", () => {
  const out = addressRows(
    [
      {
        id: "tron-pointer",
        ioc_type: "wallet_address",
        chain: "tron",
        value: "TCqf6ZkaQD84vYsC2cuu1jRwB6JveTaRrF",
        c2_hosts: ["192.0.2.1", "192.0.2.9"],
        c2_history: [{ host: "192.0.2.1", since: "2026-09-08", until: "2026-09-26" }],
      },
    ],
    {}
  );
  const c2 = out[0].c2;
  assert.deepEqual(c2.find((c) => c.host === "192.0.2.1"), { ...c2.find((c) => c.host === "192.0.2.1"), first: "2026-09-08", last: "2026-09-26" });
  assert.equal(c2.find((c) => c.host === "192.0.2.9").first, null);
});
