#!/usr/bin/env node
/**
 * hunt-etherhiding.js
 * ==============================================================
 * Finds EtherHiding contracts the watchlist does not carry yet and rebuilds
 * the write history of the ones it does, the method Alex Necula described in
 * "Hunting EtherHiding" (LinkedIn, 7 and 12 October 2026):
 *
 *   1. History from calldata. Every transaction sent to a contract is read
 *      from an Etherscan-compatible indexer, and the string arguments in its
 *      input are decoded as text. A contract that overwrites one storage slot
 *      and emits nothing still leaves every value it ever held in the inputs
 *      of the transactions that set it.
 *   2. History from events. Logs carrying a known rotation event, such as
 *      DataUpdated(string,string), are decoded the same way.
 *   3. Operator pivot. The wallets that wrote to a contract are read in turn;
 *      a contract one of them deployed or wrote strings to is a candidate.
 *   4. Topic sweep (--sweep). Every contract that emitted a known rotation
 *      event in the recent block window is a candidate.
 *
 * Nothing found here is filed. A candidate is an on-chain observation for a
 * person to review, and many contracts emit DataUpdated for honest reasons;
 * the output says which candidates hold host-shaped or base64-shaped strings,
 * nothing more. Retrieved data is never executed or decrypted: values are
 * decoded from ABI layout as inert text only.
 *
 * Usage:
 *   node scripts/hunt-etherhiding.js --indexer polygon=https://polygon.blockscout.com/api \
 *     --indexer ethereum=https://eth.blockscout.com/api [--seed polygon:0x...] [--sweep 200000] \
 *     [--out _drafts/etherhiding-hunt/latest.json] [--writes src/_data/etherhidingFindings/writes.json] \
 *     [--budget 200]
 *
 * Without --seed the seeds are every EVM contract and wallet in the watchlist
 * on a chain with an indexer. Writes the JSON report to --out and a defanged
 * Markdown summary beside it (same name, .md), every few addresses while it
 * runs and again at the end. --budget is a limit in minutes: once it passes,
 * the hunt stops reading, records what was left unread, and writes its report.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { keccak256 } = require("./lib/keccak256.js");

const ROOT = path.join(__dirname, "..");
const WATCHLIST = path.join(ROOT, "src", "_data", "iocs", "etherhiding-watchlist.json");
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SPACING_MS = 3000;
const PAGE = 10000;
const MAX_OPERATOR_TXS = 2000;
// How far the pivot reaches: a seed is depth 0, a swept contract or a
// contract an operator of a seed touched is depth 1, and only depths below
// this have their own operators followed. Without a limit, every contract
// that ever stored a URL (an NFT's token URI) pulled in its writers' other
// contracts, and the first full run was still crawling after four hours.
const MAX_PIVOT_DEPTH = 2;
const CHECKPOINT_EVERY = 20;
const CHECKPOINT_MS = 120000;
// Blockscout refuses a bare runtime fetch from CI runners with 403.
const USER_AGENT = "ChollimaHunter/1.0 (+https://chollimahunter.github.io/; EtherHiding hunt)";

// Rotation events seen in EtherHiding contracts. Extend as new ones turn up.
const EVENTS = ["DataUpdated(string,string)", "ConfigUpdated(string,string)", "DataSet(string)", "ConfigSet(string)"];
const topicOf = (signature) => {
  const hash = keccak256(Buffer.from(signature));
  return "0x" + (typeof hash === "string" ? hash.replace(/^0x/, "") : Buffer.from(hash).toString("hex"));
};
const TOPICS = new Map(EVENTS.map((e) => [topicOf(e), e]));

function parseArgs(argv) {
  const opts = { indexers: {}, seeds: [], sweep: 0, budget: 0, writes: null, out: path.join(ROOT, "_drafts", "etherhiding-hunt", "latest.json") };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--indexer") {
      const [chain, url] = value.split(/=(.+)/);
      (opts.indexers[chain] = opts.indexers[chain] || []).push(url);
      i++;
    } else if (flag === "--seed") {
      const [chain, address] = value.split(":");
      opts.seeds.push({ chain, address: address.toLowerCase() });
      i++;
    } else if (flag === "--sweep") {
      opts.sweep = Number(value);
      i++;
    } else if (flag === "--budget") {
      opts.budget = Number(value);
      i++;
    } else if (flag === "--writes") {
      opts.writes = path.resolve(value);
      i++;
    } else if (flag === "--out") {
      opts.out = path.resolve(value);
      i++;
    } else if (flag === "--help" || flag === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    }
  }
  return opts;
}

let lastCall = 0;
// Set from --budget. Every wait before a request checks it, so one slow
// address cannot carry the hunt past its budget.
let deadline = Infinity;
let spent = false;
async function pause(ms) {
  if (spent || Date.now() + Math.max(ms, 0) > deadline) {
    spent = true;
    throw new Error("budget spent");
  }
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
// Hosts that answered "too many requests" go last for the rest of the run,
// and a throttled call passes straight to the next indexer: backing off on
// Blockscout before reaching Etherscan, which answers at once, cost about 100
// seconds an address. Spacing is per host, so one host's wait holds no other.
const throttledHosts = new Set();
const lastCallByHost = new Map();
async function indexer(urls, params) {
  let lastError;
  const ordered = [...urls.filter((u) => !throttledHosts.has(new URL(u).host)), ...urls.filter((u) => throttledHosts.has(new URL(u).host))];
  for (const [index, base] of ordered.entries()) {
    const url = new URL(base);
    const last = index === ordered.length - 1;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    // Etherscan's V2 API (one key, a chainid per chain) takes its key from the
    // environment, so it never sits in a command line or a log.
    if (url.host === "api.etherscan.io" && process.env.ETHERSCAN_API_KEY) url.searchParams.set("apikey", process.env.ETHERSCAN_API_KEY);
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = (lastCallByHost.get(url.host) || 0) + SPACING_MS - Date.now();
      await pause(wait);
      lastCallByHost.set(url.host, Date.now());
      try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
        const body = res.ok ? await res.json() : null;
        if (body && Array.isArray(body.result)) return body.result;
        // A lookup such as getblocknobytime answers a single value, an object
        // on Blockscout and a string on Etherscan, under status "1".
        if (body && String(body.status) === "1" && body.result != null) return body.result;
        // An empty result is answered as status 0 "No ... found".
        if (body && /no (transactions|records|logs) found/i.test(String(body.message))) return [];
        lastError = new Error(`${url.host}: ${res.status} ${body ? body.message : ""}`);
        if (res.status !== 429 && !/too many/i.test(String(body && body.message))) break;
        if (!last) {
          throttledHosts.add(url.host);
          break;
        }
      } catch (err) {
        lastError = err;
      }
      await pause(10000 * (attempt + 1));
    }
  }
  throw lastError;
}

// Blockscout's REST API, for an instance that refuses its Etherscan-style
// /api from CI (polygon.blockscout.com answers 403 there). Rows are mapped to
// the txlist shape the rest of this file reads.
async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + SPACING_MS - Date.now();
    await pause(wait);
    lastCall = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (res.ok) return await res.json();
      lastError = new Error(`${new URL(url).host}: ${res.status} (v2)`);
      if (res.status !== 429) break;
    } catch (err) {
      lastError = err;
    }
    await pause(10000 * (attempt + 1));
  }
  throw lastError;
}

async function v2Pages(base, pathname, limit = 50) {
  const root = base.replace(/\/api\/?$/, "/api/v2");
  const items = [];
  let params = null;
  for (let page = 0; page < limit; page++) {
    const url = new URL(root + pathname);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    const body = await getJson(url);
    items.push(...(body.items || []));
    params = body.next_page_params;
    if (!params) break;
  }
  return items;
}

async function txlistV2(base, address) {
  const items = await v2Pages(base, `/addresses/${address}/transactions`);
  return items
    .map((x) => ({
      hash: x.hash,
      from: (x.from && x.from.hash) || "",
      to: (x.to && x.to.hash) || "",
      contractAddress: (x.created_contract && x.created_contract.hash) || "",
      input: x.raw_input || "0x",
      timeStamp: String(Math.floor(Date.parse(x.timestamp) / 1000)),
      isError: x.status === "ok" ? "0" : "1",
    }))
    .reverse();
}

async function logsV2(base, address) {
  const items = await v2Pages(base, `/addresses/${address}/logs`);
  return items.map((l) => ({ transactionHash: l.transaction_hash, topics: l.topics || [], data: l.data, timeStamp: "0x0" }));
}

// NodeReal's enhanced API, for BNB Smart Chain, which has no keyless indexer.
// Given as --indexer bsc=nodereal; the key is read from NODEREAL_API_KEY and
// never appears on a command line. nr_getTransactionByAddress lists an
// address's transactions without their input, so each one is then read with
// eth_getTransactionByHash, and a creation's receipt for the contract it made.
const NODEREAL_MAX = 2000;
async function nodereal(method, params) {
  const key = process.env.NODEREAL_API_KEY;
  if (!key) throw new Error("NODEREAL_API_KEY is not set");
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + 300 - Date.now();
    await pause(wait);
    lastCall = Date.now();
    try {
      const res = await fetch(`https://bsc-mainnet.nodereal.io/v1/${key}`, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
      });
      const body = res.ok ? await res.json() : null;
      if (body && !body.error) return body.result;
      // The message, never the URL: the URL carries the key.
      lastError = new Error(`nodereal ${method}: ${res.status} ${body && body.error ? body.error.message : ""}`);
      if (res.status !== 429) break;
    } catch (err) {
      lastError = new Error(`nodereal ${method}: ${err.name}`);
    }
    await pause(5000 * (attempt + 1));
  }
  throw lastError;
}

async function txlistNodeReal(address) {
  const hashes = new Map();
  for (const addressType of ["to", "from"]) {
    let pageKey;
    do {
      const query = { category: ["external"], addressType, address, order: "asc", excludeZero: false, maxCount: "0x3e8" };
      if (pageKey) query.pageKey = pageKey;
      const result = await nodereal("nr_getTransactionByAddress", [query]);
      for (const t of (result && result.transfers) || []) hashes.set(t.hash, Number(t.blockTimeStamp) || 0);
      pageKey = result && result.pageKey;
    } while (pageKey && hashes.size < NODEREAL_MAX);
  }
  const rows = [];
  for (const [hash, ts] of hashes) {
    const tx = await nodereal("eth_getTransactionByHash", [hash]);
    if (!tx) continue;
    let contractAddress = "";
    let isError = "0";
    if (!tx.to) {
      const receipt = await nodereal("eth_getTransactionReceipt", [hash]);
      contractAddress = (receipt && receipt.contractAddress) || "";
      if (receipt && receipt.status === "0x0") isError = "1";
    }
    rows.push({ hash, from: tx.from, to: tx.to || "", contractAddress, input: tx.input, timeStamp: String(ts), isError, blockNumber: parseInt(tx.blockNumber, 16) });
  }
  return rows.sort((a, b) => a.blockNumber - b.blockNumber);
}

async function txlist(urls, address) {
  if (urls[0] === "nodereal") return txlistNodeReal(address);
  try {
    return await indexer(urls, { module: "account", action: "txlist", address, sort: "asc", page: 1, offset: PAGE });
  } catch (err) {
    if (!/blockscout/.test(urls[0])) throw err;
    return txlistV2(urls[0], address);
  }
}

// Every log the address emitted, in one read; the caller keeps the topics it knows.
async function logs(urls, address) {
  if (urls[0] === "nodereal") {
    const found = await nodereal("eth_getLogs", [{ address, fromBlock: "0x0", toBlock: "latest" }]);
    return (found || []).map((l) => ({ transactionHash: l.transactionHash, topics: l.topics || [], data: l.data, timeStamp: "0x0" }));
  }
  try {
    return await indexer(urls, { module: "logs", action: "getLogs", address, fromBlock: 0, toBlock: "latest" });
  } catch (err) {
    if (!/blockscout/.test(urls[0])) throw err;
    return logsV2(urls[0], address);
  }
}

/**
 * Every ABI-encoded string or bytes value in a blob of call or log data. Each
 * word that reads as an in-range offset is followed to a length and bytes;
 * printable text is kept as text, anything else (an encrypted blob) as 0x hex.
 * Layout only: nothing is interpreted or run.
 */
function abiStrings(hex) {
  const data = Buffer.from(String(hex || "").replace(/^0x/, ""), "hex");
  const out = [];
  for (let w = 0; w + 32 <= data.length; w += 32) {
    const offset = Number(data.readBigUInt64BE(w + 24));
    if (data.readBigUInt64BE(w) || data.readBigUInt64BE(w + 8) || data.readBigUInt64BE(w + 16)) continue;
    if (offset % 32 || offset < 32 || offset + 32 > data.length) continue;
    const length = Number(data.readBigUInt64BE(offset + 24));
    if (!length || offset + 32 + length > data.length) continue;
    const bytes = data.subarray(offset + 32, offset + 32 + length);
    const text = bytes.toString("utf8");
    const value = /^[\x20-\x7e]+$/.test(text) ? text : length >= 8 ? "0x" + bytes.toString("hex") : null;
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// What a value looks like, for review priority only.
function shape(text) {
  if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) return "host";
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(text)) return "ip";
  if (/^0x[0-9a-f]{16,}$/.test(text)) return "binary";
  if (/^H4sI[A-Za-z0-9+/]+={0,2}$/.test(text)) return "gzip-base64";
  if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(text)) return "base64";
  if (/,/.test(text) && text.split(",").some((part) => shape(part.trim()) === "host")) return "host-list";
  return "text";
}

const defang = (s) => String(s).replace(/^http/i, "hxxp").replace(/\./g, "[.]");
const day = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

function watchlistSeeds(chains) {
  const seeds = [];
  const known = new Map();
  for (const r of JSON.parse(fs.readFileSync(WATCHLIST, "utf8"))) {
    const value = String(r.value).toLowerCase();
    if (!ADDRESS.test(value) || !chains.includes(r.chain)) continue;
    known.set(`${r.chain}:${value}`, r.id);
    if (r.ioc_type === "smart_contract_address" || r.ioc_type === "wallet_address") seeds.push({ chain: r.chain, address: value });
  }
  return { seeds, known };
}

async function contractHistory(urls, chain, address) {
  const txs = await txlist(urls, address);
  const writes = [];
  let deployer = null;
  for (const tx of txs) {
    if (!tx.to && (tx.contractAddress || "").toLowerCase() === address) deployer = tx.from.toLowerCase();
    if ((tx.to || "").toLowerCase() !== address || String(tx.isError) === "1") continue;
    const values = abiStrings(String(tx.input).slice(10));
    if (!values.length) continue;
    writes.push({ tx: tx.hash, date: day(tx.timeStamp), from: tx.from.toLowerCase(), selector: String(tx.input).slice(0, 10), values });
  }
  const events = [];
  for (const log of await logs(urls, address).catch((err) => {
    if (spent) throw err;
    return [];
  })) {
    const name = TOPICS.get(String((log.topics || [])[0] || "").toLowerCase());
    if (!name) continue;
    const ts = parseInt(log.timeStamp, 16);
    events.push({ tx: log.transactionHash, date: ts ? day(ts) : null, event: name, values: abiStrings(log.data) });
  }
  // A seed is a wallet only when it was never created as a contract.
  const isContract = Boolean(deployer) || txs.some((tx) => (tx.contractAddress || "").toLowerCase() === address);
  return { chain, address, deployer, isContract, transactions: txs.length, writes, events };
}

async function operatorLeads(urls, operator) {
  const txs = (await txlist(urls, operator)).slice(-MAX_OPERATOR_TXS);
  const leads = new Map();
  for (const tx of txs) {
    if ((tx.from || "").toLowerCase() !== operator) continue;
    if (!tx.to && tx.contractAddress) leads.set(tx.contractAddress.toLowerCase(), "deployed by operator");
    else if (tx.to && abiStrings(String(tx.input).slice(10)).length && !leads.has(tx.to.toLowerCase())) {
      leads.set(tx.to.toLowerCase(), "operator wrote strings to it");
    }
  }
  return leads;
}

async function sweep(urls, blocks) {
  if (urls[0] === "nodereal") return new Map();
  const head = await indexer(urls, { module: "block", action: "getblocknobytime", timestamp: Math.floor(Date.now() / 1000) - 120, closest: "before" })
    .then((r) => Number(r.blockNumber || r))
    .catch(() => null);
  const found = new Map();
  for (const [topic, name] of TOPICS) {
    // Without the head block the window is unknown, and a sweep from block 0
    // would read the whole chain; skip it rather than guess.
    if (!head) throw new Error("could not read the head block, sweep skipped");
    const params = { module: "logs", action: "getLogs", topic0: topic, toBlock: "latest", fromBlock: Math.max(0, head - blocks) };
    const logs = await indexer(urls, params).catch((err) => {
      if (spent) throw err;
      return [];
    });
    for (const log of logs) {
      const a = log.address.toLowerCase();
      if (!found.has(a)) found.set(a, `emitted ${name}`);
    }
  }
  return found;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chains = Object.keys(opts.indexers);
  if (!chains.length) throw new Error("no --indexer given");
  const { seeds: listed, known } = watchlistSeeds(chains);
  const seeds = opts.seeds.length ? opts.seeds : listed;
  const report = { ran_at: new Date().toISOString(), chains, events: EVENTS, contracts: [], candidates: [], failures: [], unread: 0 };
  const seen = new Set();
  const started = Date.now();
  deadline = opts.budget ? started + opts.budget * 60000 : Infinity;
  const elapsed = () => `${Math.round((Date.now() - started) / 60000)}m`;

  // Contracts first; when none are left, the wallets that wrote to them are
  // read for further contracts, until neither yields anything new.
  const queue = seeds.filter((s) => opts.indexers[s.chain]).map((s) => ({ ...s, via: "seed", depth: 0 }));
  const operators = new Map();

  const save = (final) => {
    report.unread = queue.length + operators.size;
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(opts.out.replace(/\.json$/, ".md"), summary(report));
    if (final && opts.writes) writeHistories(opts.writes, report);
  };
  // A cancelled job is sent SIGTERM before it is killed: keep what was read.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      report.failures.push(`stopped by ${signal} after ${elapsed()}`);
      save(true);
      process.exit(1);
    });
  }

  for (const [chain, urls] of Object.entries(opts.indexers)) {
    if (!opts.sweep) continue;
    try {
      const found = await sweep(urls, opts.sweep);
      console.log(`${chain} sweep: ${found.size} contract(s) emitted a rotation event`);
      for (const [address, via] of found) queue.push({ chain, address, via, depth: 1 });
    } catch (err) {
      report.failures.push(`${chain} sweep: ${err.message}`);
    }
  }

  let read = 0;
  let saved = Date.now();
  while (queue.length || operators.size) {
    if (spent || Date.now() > deadline) {
      report.failures.push(`stopped at the ${opts.budget}-minute budget with ${queue.length} address(es) and ${operators.size} operator(s) unread`);
      break;
    }
    if (!queue.length) {
      const [op, depth] = operators.entries().next().value;
      operators.delete(op);
      if (seen.has(`op:${op}`)) continue;
      seen.add(`op:${op}`);
      const [chain, address] = op.split(":");
      try {
        const leads = await operatorLeads(opts.indexers[chain], address);
        console.log(`[${elapsed()}] operator ${op}: ${leads.size} lead(s)`);
        for (const [lead, via] of leads) {
          if (!seen.has(`${chain}:${lead}`)) queue.push({ chain, address: lead, via: `${via} (${address})`, depth: depth + 1 });
        }
      } catch (err) {
        if (spent) {
          seen.delete(`op:${op}`);
          operators.set(op, depth);
        } else report.failures.push(`operator ${op}: ${err.message}`);
      }
      continue;
    }
    const item = queue.shift();
    const key = `${item.chain}:${item.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const urls = opts.indexers[item.chain];
    try {
      const history = await contractHistory(urls, item.chain, item.address);
      console.log(`[${elapsed()}] ${key} (${item.via}): ${history.transactions} tx, ${history.writes.length} write(s), ${history.events.length} event(s); ${queue.length} queued`);
      if (!history.isContract && !history.writes.length && !history.events.length && item.via === "seed") {
        // A wallet seed: pivot on it directly.
        operators.set(key, item.depth);
        continue;
      }
      const entry = { ...history, via: item.via, watchlist_id: known.get(key) || null };
      const values = [...entry.writes, ...entry.events].flatMap((w) => w.values);
      entry.shapes = [...new Set(values.map(shape))];
      (entry.watchlist_id ? report.contracts : report.candidates).push(entry);
      const worthFollowing = item.via === "seed" || entry.watchlist_id || entry.shapes.some((s) => s !== "text");
      if (worthFollowing && item.depth < MAX_PIVOT_DEPTH) {
        for (const w of entry.writes) if (!operators.has(`${item.chain}:${w.from}`)) operators.set(`${item.chain}:${w.from}`, item.depth);
        if (entry.deployer && !operators.has(`${item.chain}:${entry.deployer}`)) operators.set(`${item.chain}:${entry.deployer}`, item.depth);
      }
    } catch (err) {
      // The address the budget ran out on is left unread, not failed.
      if (spent) queue.unshift(item);
      else report.failures.push(`${key}: ${err.message}`);
    }
    if (++read % CHECKPOINT_EVERY === 0 || Date.now() - saved > CHECKPOINT_MS) {
      save(false);
      saved = Date.now();
    }
  }

  save(true);
  console.log(`${report.contracts.length} watchlisted contract(s) read, ${report.candidates.length} candidate(s), ${report.failures.length} failure(s), ${report.unread} left unread, in ${elapsed()}`);
}

// Values are the operator's: kept as text, cut to a length a table can show.
const MAX_VALUE = 300;

/**
 * The write history of every watchlisted contract, for its indicator page:
 * date, transaction, sender and the string values written, oldest first. A
 * contract this run could not read keeps the history an earlier run recorded,
 * so a throttled indexer does not erase it.
 */
function writeHistories(file, report) {
  let previous = {};
  // A missing file is a first run; a corrupt one must stop the run rather than
  // be overwritten with only what this run read.
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8")).contracts || {};
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const contracts = { ...previous };
  for (const c of report.contracts) {
    const rows = [...c.writes, ...c.events.map((e) => ({ ...e, from: null, selector: e.event }))]
      .map((w) => ({ tx: w.tx, date: w.date, from: w.from, method: w.selector, values: w.values.map((v) => v.slice(0, MAX_VALUE)) }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (rows.length || !contracts[`${c.chain}:${c.address}`]) contracts[`${c.chain}:${c.address}`] = rows;
  }
  const sorted = Object.fromEntries(Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ _comment: "Written by scripts/hunt-etherhiding.js --writes: each watchlisted contract's write transactions, keyed chain:address, decoded from calldata and rotation events as text. Shown on the contract's indicator page.", updated: report.ran_at.slice(0, 10), contracts: sorted }, null, 2) + "\n");
}

function summary(report) {
  const lines = [`# EtherHiding hunt, ${report.ran_at.slice(0, 10)}`, "", `Chains: ${report.chains.join(", ")}. Values are defanged; nothing here is filed.`, ""];
  const strong = report.candidates.filter((c) => c.shapes.some((s) => s !== "text"));
  lines.push(`## Candidates with host, IP or base64 values (${strong.length})`, "");
  for (const c of strong) {
    const all = [...c.writes, ...c.events];
    lines.push(`- ${c.chain}:${c.address}, ${c.via}; ${all.length} write(s) ${all[0] ? all[0].date : ""} to ${all.length ? all[all.length - 1].date : ""}; shapes ${c.shapes.join(", ")}`);
    for (const v of [...new Set(all.flatMap((w) => w.values))].slice(-5)) lines.push(`  - ${defang(v).slice(0, 160)}`);
  }
  lines.push("", `## Watchlisted contracts with a recovered history (${report.contracts.length})`, "");
  for (const c of report.contracts) lines.push(`- ${c.watchlist_id}: ${c.writes.length} write(s), ${c.events.length} event(s)`);
  if (report.failures.length) lines.push("", "## Failures", "", ...report.failures.map((f) => `- ${f}`));
  return lines.join("\n") + "\n";
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
