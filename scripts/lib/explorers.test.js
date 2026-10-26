"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { explorerUrl, explorerName } = require("./explorers.js");

test("each listed chain links addresses and transactions to its explorer", () => {
  const cases = [
    ["ethereum", "address", "0xabc", "https://etherscan.io/address/0xabc"],
    ["ethereum", "tx", "0x01", "https://etherscan.io/tx/0x01"],
    ["bsc", "tx", "0x01", "https://bscscan.com/tx/0x01"],
    ["tron", "address", "TCqf6ZkaQD84vYsC2cuu1jRwB6JveTaRrF", "https://tronscan.org/#/address/TCqf6ZkaQD84vYsC2cuu1jRwB6JveTaRrF"],
    ["tron", "address", "3fa56cbb", "https://tronscan.org/#/transaction/3fa56cbb"],
    ["tron", "tx", "0x87b7", "https://tronscan.org/#/transaction/87b7"],
    ["aptos", "tx", "0x45", "https://explorer.aptoslabs.com/txn/0x45?network=mainnet"],
  ];
  for (const [chain, kind, value, want] of cases) assert.equal(explorerUrl(value, chain, kind), want);
});

test("an unlisted chain or a missing value gets no link", () => {
  assert.equal(explorerUrl("0xabc", "solana"), null);
  assert.equal(explorerUrl("", "ethereum"), null);
  assert.equal(explorerUrl("0xabc", null), null);
  assert.equal(explorerName("bsc"), "BscScan");
  assert.equal(explorerName("solana"), null);
});

test("Polygon and Sepolia link to their explorers", () => {
  assert.equal(explorerUrl("0xabc", "polygon", "tx"), "https://polygonscan.com/tx/0xabc");
  assert.equal(explorerUrl("0xabc", "sepolia"), "https://sepolia.etherscan.io/address/0xabc");
  assert.equal(explorerName("sepolia"), "Sepolia Etherscan");
});
