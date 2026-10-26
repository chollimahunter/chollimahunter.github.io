/**
 * table-rows.test.js -- the one-cell-per-line indicator table shape
 * ==========================================================================
 * The cases are rows of eSentire's and Sysdig's EtherRAT appendices, which
 * rendered each cell on its own line and lost every domain and digest before
 * typedTableRow existed. Run with `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defang,
  typedTableRow,
  rowDescribesOperatorInfra,
  isLabelledContract,
  HASH_TYPE_CELL,
} = require("./ioc-normalize.js");

const TABLE = [
  " URL ",
  " https://nodejs.org/dist/v18.17.0/node-v18.17.0-win-x64.zip ",
  " Node.js download URL ",
  "",
  " Domain ",
  "",
  " jariosos.com ",
  "",
  " EtherRAT C2 ",
  "",
  " File ",
  " 5623f4f8942872b2b7cb6d2674c126a42bdf6ed5d1f37c1afc348529e4697d73 ",
  " EtherRAT stage 1 ",
  " Domain ",
  " www-flow-submission-management.shepherdsestates.uk ",
  " Compromised website serving HTA/MSI ",
  " Smart contract ",
  " 0x22f96d61cf118efabc7c5bf3384734fad2f6ead4 ",
  " Deployer wallet ",
  " 0xe941a9b283006f5163ee6b01c1f23aa5951c4c8d ",
].join("\n");

function rowOf(value) {
  const index = TABLE.indexOf(value);
  assert.ok(index >= 0, value);
  return typedTableRow(TABLE, index, value.length);
}

test("typedTableRow reads the type cell above and the description below, across blank lines", () => {
  assert.deepEqual(rowOf("jariosos.com"), { cell: "domain", description: "EtherRAT C2" });
  const hash = rowOf("5623f4f8942872b2b7cb6d2674c126a42bdf6ed5d1f37c1afc348529e4697d73");
  assert.equal(hash.cell, "file");
  assert.equal(hash.description, "EtherRAT stage 1");
  assert.ok(HASH_TYPE_CELL.test(hash.cell));
});

test("typedTableRow refuses a value that is not alone on its line or has no type cell above", () => {
  const prose = "The malware beacons to jariosos.com every hour.\n\nDomain\n";
  assert.equal(typedTableRow(prose, prose.indexOf("jariosos.com"), 12), null);
  const noCell = "Some heading\njariosos.com\nEtherRAT C2\n";
  assert.equal(typedTableRow(noCell, noCell.indexOf("jariosos.com"), 12), null);
});

test("rowDescribesOperatorInfra takes C2 and refuses compromised sites and plain downloads", () => {
  assert.equal(rowDescribesOperatorInfra("EtherRAT C2"), true);
  assert.equal(rowDescribesOperatorInfra("Malware download server"), true);
  assert.equal(rowDescribesOperatorInfra("Compromised website serving HTA/MSI"), false);
  assert.equal(rowDescribesOperatorInfra("Node.js download URL"), false);
  assert.equal(rowDescribesOperatorInfra("Domain"), false);
  assert.equal(rowDescribesOperatorInfra(""), false);
});

test("a nodejs.org row is not hostile and a compromised-site row is refused", () => {
  const url = "https://nodejs.org/dist/v18.17.0/node-v18.17.0-win-x64.zip";
  assert.equal(rowDescribesOperatorInfra(rowOf(url).description), false);
  const site = "www-flow-submission-management.shepherdsestates.uk";
  assert.equal(rowDescribesOperatorInfra(rowOf(site).description), false);
});

test("isLabelledContract separates a contract from a deployer wallet", () => {
  const contract = "0x22f96d61cf118efabc7c5bf3384734fad2f6ead4";
  const wallet = "0xe941a9b283006f5163ee6b01c1f23aa5951c4c8d";
  assert.equal(isLabelledContract(TABLE, TABLE.indexOf(contract), contract.length), true);
  assert.equal(isLabelledContract(TABLE, TABLE.indexOf(wallet), wallet.length), false);
  const prose = "EtherRAT queries a smart contract at address 0x22f96d61cf118efabc7c5bf3384734fad2f6ead4 using a selector.";
  assert.equal(isLabelledContract(prose, prose.indexOf("0x22"), contract.length), true);
  const sentence = "The Ethereum smart contract address 0xe26c57b7fa8de030238b0a71b3d063397ac127d3 appears often.";
  assert.equal(isLabelledContract(sentence, sentence.indexOf("0xe2"), 42), true);
  const funded = "Funds were sent to 0xe941a9b283006f5163ee6b01c1f23aa5951c4c8d from an exchange.";
  assert.equal(isLabelledContract(funded, funded.indexOf("0xe9"), 42), false);
});

test("defang closes the space a rendered code block leaves after the scheme colon", () => {
  assert.equal(defang("http: //91.215.85.42:3000/crypto/keys"), "http://91.215.85.42:3000/crypto/keys");
  assert.equal(defang("X-Bot-Server: https: //c2.example.com"), "X-Bot-Server: https://c2.example.com");
  assert.equal(defang("see the note: http://x.test"), "see the note: http://x.test");
});
