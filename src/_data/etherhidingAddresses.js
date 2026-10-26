// The address table on /etherhiding/ (rows) and the On-chain links section
// of each /indicators/{id}/ page (links, keyed by indicator id; writes, each
// contract's write transactions): each watchlisted contract and wallet
// with the C2 hosts tied to it, most recently active first. Built by
// scripts/lib/etherhiding-addresses.js from the watchlist and the checker's
// latest run. Hosts scripts/data/etherhiding-c2-review.json records as parked
// values, placeholders or services are kept apart as each row's `decoys`.
const path = require("path");
const buildIocIndex = require("./iocIndex.js");
const { readJsonIfPresent } = require("../../scripts/lib/read-json.js");
const HOST_TYPES = new Set(["ip_address", "domain", "hosted_site"]);
const { addressRows, onChainLinks, hostOf } = require("../../scripts/lib/etherhiding-addresses.js");

module.exports = function () {
  const latest = readJsonIfPresent(path.join(__dirname, "etherhidingFindings", "latest.json"), {});
  const review = readJsonIfPresent(path.join(__dirname, "..", "..", "scripts", "data", "etherhiding-c2-review.json"), {});
  const index = buildIocIndex();
  const indexed = new Map();
  const records = new Map();
  for (const area of [index.remote_workers, index.espionage, index.etherhiding]) {
    for (const record of area.records) {
      records.set(record.id, record);
      if (HOST_TYPES.has(record.ioc_type)) indexed.set(hostOf(record.value), record.id);
    }
  }
  const registrations = readJsonIfPresent(path.join(__dirname, "..", "..", "scripts", "data", "domain-registration.json"), { domains: {} }).domains;
  const rows = addressRows(index.etherhiding.watchlist, latest, review, indexed);
  // The tracker's Family and Chain filters, by the value each row carries.
  const CHAIN_LABELS = { ethereum: "Ethereum", bsc: "BNB Smart Chain", tron: "TRON", aptos: "Aptos", polygon: "Polygon", sepolia: "Ethereum Sepolia (testnet)" };
  const facets = { family: {}, chain: {} };
  for (const row of rows) {
    row.family_label = row.malware_family || "Unspecified";
    row.chain_label = CHAIN_LABELS[row.chain] || row.chain || "Unspecified";
    facets.family[row.family_label] = (facets.family[row.family_label] || 0) + 1;
    facets.chain[row.chain_label] = (facets.chain[row.chain_label] || 0) + 1;
  }
  // Each contract's write transactions, from scripts/hunt-etherhiding.js
  // --writes, newest first, keyed by indicator id; a sender that is itself an
  // indicator links to its page.
  const writesDoc = readJsonIfPresent(path.join(__dirname, "etherhidingFindings", "writes.json"), { contracts: {} });
  const idByAddress = new Map();
  for (const record of records.values()) {
    if (/^0x[0-9a-f]{40}$/i.test(String(record.value))) idByAddress.set(String(record.value).toLowerCase(), record.id);
  }
  const writes = {};
  for (const row of rows) {
    const list = row.indicator_id && (writesDoc.contracts || {})[`${row.chain}:${String(row.value).toLowerCase()}`];
    if (!list || !list.length) continue;
    writes[row.indicator_id] = list
      .map((w) => ({ ...w, chain: row.chain, from_id: w.from ? idByAddress.get(w.from) || null : null }))
      .reverse();
  }
  const sorted = (counts) => Object.fromEntries(Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
  return { rows, facets: { family: sorted(facets.family), chain: sorted(facets.chain) }, links: onChainLinks(rows, records, registrations), writes, writes_updated: writesDoc.updated || null };
};
