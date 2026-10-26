"use strict";

/**
 * etherhiding-pointers.js
 * ==============================================================
 * Reads the XCTDH (Cross-Chain TxDataHiding) pointer accounts the EVM checker
 * cannot: a TRON wallet and an Aptos account whose outbound transactions each
 * name a BNB Smart Chain transaction. The malware takes the pointer's latest
 * write, fetches that BSC transaction and decrypts its calldata as the next
 * stage, so rewriting the pointer is a single transaction and the only place
 * the change shows first.
 *
 * TRON: the transaction's raw_data.data is the BSC hash, reversed and
 * hex-encoded. Aptos: the BSC hash is payload.arguments[0]. Both APIs are
 * public and keyless (TronGrid, the Aptos fullnode REST API).
 *
 * The result is shaped as an observation with a rotation timeline, the same
 * shape the EVM resolver wallets use, with the BSC transaction hash as the
 * run's destination ("to"), so the review gate and the tracker need no second
 * format. Nothing read from the chain is evaluated, and the payloads the
 * hashes name are not fetched or decoded here (see
 * _drafts/xctdh-decoder/README.md for the by-hand decoder).
 */

const BSC_HASH_RE = /^0x[0-9a-f]{64}$/i;
const TRON_API = "https://api.trongrid.io";
const APTOS_API = "https://api.mainnet.aptoslabs.com/v1";
const TIMEOUT_MS = 20000;
const PAGE_DELAY_MS = 1000;
const MAX_PAGES = 200;
const ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A pointer write from one TronGrid transaction, or null when it is not one. */
function tronWrite(tx) {
  const hex = tx && tx.raw_data && tx.raw_data.data;
  if (typeof hex !== "string" || !/^([0-9a-f]{2})+$/i.test(hex)) return null;
  const reversed = Buffer.from(hex, "hex").toString("utf8").split("").reverse().join("");
  if (!BSC_HASH_RE.test(reversed)) return null;
  const time = Number(tx.block_timestamp);
  if (!Number.isFinite(time) || !tx.txID) return null;
  return { time, day: day(time), bsc: reversed.toLowerCase(), tx: String(tx.txID) };
}

/** A pointer write from one Aptos transaction (timestamps are microseconds), or null. */
function aptosWrite(tx) {
  const arg = tx && tx.payload && Array.isArray(tx.payload.arguments) ? tx.payload.arguments[0] : null;
  if (typeof arg !== "string" || !BSC_HASH_RE.test(arg)) return null;
  const time = Math.floor(Number(tx.timestamp) / 1000);
  if (!Number.isFinite(time) || !tx.hash) return null;
  return { time, day: day(time), bsc: arg.toLowerCase(), tx: String(tx.hash) };
}

/**
 * Writes collapsed into runs of one named BSC transaction, oldest first, in
 * the shape rotationTimeline gives an EVM resolver wallet. Consecutive writes
 * naming the same transaction are one run; the pointer serves the payload it
 * wrote last, so a run lasts until the next differing write.
 */
function pointerRotation(writes) {
  const ordered = [...writes].sort((a, b) => a.time - b.time);
  const runs = [];
  for (const w of ordered) {
    const last = runs[runs.length - 1];
    if (last && last.to === w.bsc) {
      last.until = w.day;
      last.count++;
      last.last_tx = w.tx;
      continue;
    }
    runs.push({ to: w.bsc, resolved_ip: null, label: null, from: w.day, until: w.day, count: 1, first_tx: w.tx, last_tx: w.tx });
  }
  return runs;
}

async function getJson(url, fetchFn, delay) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < ATTEMPTS) await delay(3000 * attempt);
  }
  throw lastError;
}

/** Every pointer write the TRON account has sent. Throws if any page cannot be read. */
async function readTronWrites(address, { fetchFn = fetch, delay = sleep } = {}) {
  const writes = [];
  let url = `${TRON_API}/v1/accounts/${encodeURIComponent(address)}/transactions?only_confirmed=true&only_from=true&limit=200`;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages`);
    const body = await getJson(url, fetchFn, delay);
    if (!body || !Array.isArray(body.data)) throw new Error("unexpected TronGrid response");
    for (const tx of body.data) {
      const write = tronWrite(tx);
      if (write) writes.push(write);
    }
    const next = body.meta && body.meta.links && body.meta.links.next;
    // The next link is followed only on the host that was asked.
    url = typeof next === "string" && next.startsWith(`${TRON_API}/`) ? next : null;
    if (url) await delay(PAGE_DELAY_MS);
  }
  return writes;
}

/** Every pointer write the Aptos account has sent. Throws if any page cannot be read. */
async function readAptosWrites(address, { fetchFn = fetch, delay = sleep } = {}) {
  const writes = [];
  let start = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages`);
    const body = await getJson(`${APTOS_API}/accounts/${encodeURIComponent(address)}/transactions?limit=100&start=${start}`, fetchFn, delay);
    if (!Array.isArray(body)) throw new Error("unexpected Aptos response");
    for (const tx of body) {
      const write = aptosWrite(tx);
      if (write) writes.push(write);
    }
    if (body.length < 100) return writes;
    start = Number(body[body.length - 1].sequence_number) + 1;
    if (!Number.isFinite(start)) throw new Error("unexpected Aptos sequence number");
    await delay(PAGE_DELAY_MS);
  }
}

/**
 * Prepends the runs an earlier refresh recorded that the API no longer
 * returns. The Aptos fullnode prunes its ledger after about ten days, so an
 * account's oldest writes drop out of every later read; without this each
 * refresh would erase the start of the timeline and the review gate would hold
 * the run as rewritten history. A previous run is kept only when it ended no
 * later than the oldest run read now and none of its transactions is in the
 * current read; a run the pruning cut through keeps its original start.
 */
function keepPrunedRuns(previous, current) {
  const before = new Map((previous || []).map((o) => [`${o.chain}:${o.target}`, o]));
  for (const now of current) {
    if (now.kind !== "pointer" || !Array.isArray(now.rotation)) continue;
    const then = before.get(`${now.chain}:${now.target}`);
    if (!then || !Array.isArray(then.rotation) || !then.rotation.length) continue;
    const runs = now.rotation;
    if (!runs.length) {
      now.rotation = then.rotation.map((r) => ({ ...r }));
      continue;
    }
    const seen = new Set(runs.flatMap((r) => [r.first_tx, r.last_tx]));
    const oldest = runs[0];
    const kept = [];
    for (const run of then.rotation) {
      if (seen.has(run.first_tx) || seen.has(run.last_tx) || run.until > oldest.from) break;
      kept.push({ ...run });
    }
    // The run the window cut through: the same destination, recorded as
    // starting earlier than the oldest write still served.
    const last = kept[kept.length - 1];
    if (last && last.to === oldest.to) {
      kept.pop();
      oldest.from = last.from;
      oldest.first_tx = last.first_tx;
      oldest.count += last.count;
    } else {
      const cut = then.rotation[kept.length];
      if (cut && cut.to === oldest.to && cut.from < oldest.from) {
        // Exact when the run has not grown since; otherwise the overlap is
        // unknown and the larger count is the closer lower bound.
        oldest.count = cut.last_tx === oldest.last_tx ? cut.count : Math.max(oldest.count, cut.count);
        oldest.from = cut.from;
        oldest.first_tx = cut.first_tx;
      }
    }
    now.rotation = [...kept, ...runs];
  }
}

const isPointerEntry = (e) => (e.chain === "tron" || e.chain === "aptos") && e.ioc_type === "wallet_address" && /pointer/.test(e.onchain_role || "");

/**
 * One observation per TRON or Aptos pointer entry. A failed read yields an
 * observation without a rotation (the caller carries the previous run's
 * forward) and a query line ending " -- FAILED", which the review gate counts
 * toward its degraded-run threshold exactly as it counts a failed EVM query.
 */
async function readPointers(entries, options = {}) {
  const delay = options.delay || sleep;
  const observations = [];
  const queries = [];
  for (const entry of entries.filter(isPointerEntry)) {
    const api = entry.chain === "tron" ? "TronGrid" : "Aptos REST";
    const observation = { id: entry.id, target: entry.value, kind: "pointer", chain: entry.chain };
    try {
      const writes = await (entry.chain === "tron" ? readTronWrites : readAptosWrites)(entry.value, options);
      observation.rotation = pointerRotation(writes);
      queries.push(`${api} transactions of ${entry.chain} pointer ${entry.value} -- ${writes.length} pointer write(s) in ${observation.rotation.length} run(s)`);
    } catch (err) {
      queries.push(`${api} transactions of ${entry.chain} pointer ${entry.value} -- FAILED: ${err.message}`);
    }
    observations.push(observation);
    await delay(PAGE_DELAY_MS);
  }
  return { observations, queries };
}

module.exports = { tronWrite, aptosWrite, pointerRotation, readTronWrites, readAptosWrites, readPointers, keepPrunedRuns, isPointerEntry };
