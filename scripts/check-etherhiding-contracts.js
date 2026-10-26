#!/usr/bin/env node
/**
 * check-etherhiding-contracts.js
 * ==============================================================
 * The EtherHiding checker tool designed in docs/etherhiding-contract-check.md.
 * Tests candidate smart-contract addresses against
 * src/_data/iocs/etherhiding-watchlist.json and writes the outcome to
 * src/_data/etherhidingFindings/latest.json, which /etherhiding/results/
 * renders.
 *
 * Run manually:
 *   node scripts/check-etherhiding-contracts.js --address 0x8eac...     # mode 1
 *   node scripts/check-etherhiding-contracts.js --file candidates.txt   # mode 1
 *   node scripts/check-etherhiding-contracts.js --address 0x... --rpc <url>
 *   node scripts/check-etherhiding-contracts.js --tx 0x... --rpc <url>  # calldata
 *   node scripts/check-etherhiding-contracts.js --refresh --rpc bsc=<url> --rpc ethereum=<url>   # mode 3
 *
 * Prints "CHANGED=true"/"CHANGED=false" as its last line of stdout, so a future
 * scheduled workflow can open a pull request only when the findings moved.
 *
 * WHAT A MATCH MEANS
 * ------------------
 * That the candidate appears in publicly cited threat-intel reporting, or that
 * data read from it matched a published detection pattern. It is not a finding
 * that the contract is currently serving malicious content, and on-chain data
 * being public does not establish intent. Every row this writes is a starting
 * point for manual review -- the results page states the same, and the
 * disclaimer there is not optional.
 *
 * TWO RULES THIS TOOL MUST NOT BEND
 * ---------------------------------
 * Retrieved contract data is never executed. Bytecode, calldata and return
 * values are inspected as inert bytes, the way a defender should treat any
 * attacker-controlled blockchain data. There is no eval, no Function, no
 * dynamic require anywhere in this file.
 *
 * A query that fails is recorded, never omitted and never replaced with a
 * plausible-looking result. An unreachable endpoint, a rate limit, an address
 * that turns out not to be a contract -- each is written into
 * queries_executed verbatim, because a findings file that quietly drops its
 * failures reads as a clean run.
 *
 * NO CREDENTIALS ARE BUNDLED. Modes 2 and 3 do nothing without an endpoint the
 * site owner supplies, and stop with an error rather than skipping the on-chain
 * portion silently. No API key is needed for either, though: the payload
 * accessor is recovered from the contract's own bytecode rather than from a
 * verified ABI, so --explorer is an optional refinement and not a prerequisite.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { selectorFor, selfTest: keccakSelfTest } = require("./lib/keccak256.js");
const { readStorageStrings, shapeScore, sha256, walkPayloadWrites } = require("./lib/etherhiding-shape.js");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { decodedIps } = require("./lib/etherhiding-addresses.js");
const { readPointers, keepPrunedRuns, isPointerEntry } = require("./lib/etherhiding-pointers.js");

const ROOT = path.join(__dirname, "..");
const WATCHLIST_PATH = path.join(ROOT, "src", "_data", "iocs", "etherhiding-watchlist.json");
const FINDINGS_PATH = path.join(ROOT, "src", "_data", "etherhidingFindings", "latest.json");

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Watchlist types whose value is an EVM address, and so can be compared
 * against a candidate or re-read from a chain. A contract and an
 * attacker-controlled wallet are both 20-byte addresses; only what is at them
 * differs, which is what the live check reports. Transaction hashes and file
 * hashes are in the watchlist too and are deliberately not here -- they are
 * 32-byte values that no address comparison should ever match.
 */
const ADDRESS_TYPES = new Set(["smart_contract_address", "wallet_address"]);

/**
 * Watchlist types whose value is a 32-byte transaction hash. These are read
 * with eth_getTransactionByHash rather than eth_getCode, and they matter more
 * than the address types for this technique: the reported INVISIBLEFERRET
 * payloads were not stored in contract state at all but sent as calldata to
 * the burn address, where they are permanent, public, and retrievable from the
 * hash alone. A checker that only reads contracts cannot see them.
 */
const TX_HASH_TYPES = new Set(["transaction_hash"]);
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const REQUEST_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETURN_BYTES = 2_000_000;

/** Ceiling on probes per contract, so a large dispatch table cannot become a flood of calls. */
const MAX_PROBES = 64;

/**
 * Zero-argument getters tried when no verified ABI is available. An EtherHiding
 * contract stores its payload in state and exposes a read-only accessor for it;
 * without an ABI the accessor's name is unknown, so this is a guess list and is
 * recorded as one in queries_executed. Supplying --explorer replaces the
 * guessing with the contract's real view methods.
 *
 * getString() and getName() lead because they are the accessors named in public
 * write-ups and reproductions of the technique -- the latter returning `bytes`
 * holding the payload, paired with a setter the operator calls to rotate it.
 */
const CANDIDATE_GETTERS = [
  "getString()", "getName()", "get()", "getData()", "getPayload()", "getContent()",
  "getValue()", "getCode()", "getScript()", "getConfig()", "getMessage()",
  "retrieve()", "data()", "payload()", "content()", "value()", "script()",
  "code()", "config()", "message()", "read()", "link()", "url()", "text()",
];

/**
 * Every 4-byte selector the deployed bytecode dispatches on.
 *
 * Solidity compiles a contract's public interface into its own code: incoming
 * calls are routed by comparing the caller's selector against constants
 * embedded as PUSH4 immediates. That dispatch table is readable from the
 * bytecode, which means the payload accessor can be called by its real
 * selector without knowing its name, without a verified ABI, and without an
 * explorer API key. Guessing 24 English method names was the weakest part of
 * this tool; the contract states its own answer.
 *
 * The walk respects PUSH operands instead of scanning for 0x63 blindly. A
 * PUSH32 constant that happens to contain that byte is data, not an opcode,
 * and reading it as one invents selectors the contract never had.
 */
function selectorsFromBytecode(code) {
  const found = [];
  const seen = new Set();
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op < 0x60 || op > 0x7f) continue; // not a PUSH1..PUSH32
    const width = op - 0x5f;
    if (op === 0x63 && i + 4 < code.length) {
      const selector = `0x${code.subarray(i + 1, i + 5).toString("hex")}`;
      // Both appear as arithmetic masks in ordinary code, never as selectors.
      if (selector !== "0x00000000" && selector !== "0xffffffff" && !seen.has(selector)) {
        seen.add(selector);
        found.push(selector);
      }
    }
    i += width;
  }
  return found;
}

/**
 * Tokens reported when retrieved data matches no published pattern.
 *
 * A run that reads a payload and matches nothing should still tell a reviewer
 * what it saw. Naming which of these appeared says that without copying
 * attacker-controlled text into a file this repo publishes -- the content stays
 * on chain, and what lands here is a description of it.
 */
const CHARACTERIZATION_TOKENS = [
  "eval(", "Function(", "atob(", "fetch(", "XMLHttpRequest", "require(",
  "child_process", "process.env", "Buffer.from", "http://", "https://",
  "eth_call", "ethers", "web3",
];

/** Bits of entropy per byte. Around 8 is random or encrypted; English and code sit near 4 to 5. */
function shannonEntropy(bytes) {
  if (!bytes.length) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of bytes) counts[byte]++;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function characterize(texts) {
  const present = new Set();
  let largest = texts[0];
  for (const view of texts) {
    if (view.text.length > largest.text.length) largest = view;
    for (const token of CHARACTERIZATION_TOKENS) {
      if (view.text.includes(token)) present.add(token);
    }
  }
  const tokens = present.size ? `tokens present: ${[...present].join(", ")}` : "no notable tokens";

  // Entropy separates the two reasons a payload matches nothing: it is not
  // there, or it is there and encoded. The published patterns describe
  // plaintext JavaScript, so an encoded blob is out of their reach and a run
  // that only said "no match" would read as the first case.
  // Measured on the highest-entropy view, not the longest. A base64 blob and
  // the bytes it decodes to are both in this list; scoring the printable
  // wrapper would call an encrypted payload plaintext because its envelope is
  // made of letters.
  let peak = { label: largest.label, entropy: 0 };
  for (const view of texts) {
    const entropy = shannonEntropy(Buffer.from(view.text, "latin1"));
    if (entropy > peak.entropy) peak = { label: view.label, entropy };
  }
  const reading =
    peak.entropy > 5.5
      ? "encoded or encrypted, not plaintext -- outside the reach of the published plaintext patterns"
      : "plaintext-like";

  return (
    `${texts.length} derived text view(s), longest ${largest.text.length.toLocaleString("en-US")} chars ` +
    `(${largest.label}); highest entropy ${peak.entropy.toFixed(2)} bits/byte in the ${peak.label} view: ` +
    `${reading}; ${tokens}`
  );
}

/**
 * An address read as ASCII, which is the whole of the NullReceiver technique.
 *
 * That malware stores no payload: it encodes a command-and-control address in
 * the 20 bytes of a transfer recipient, where a zero-value zero-data
 * transaction carries it in the clear. Decoding every address this tool sees
 * costs nothing and is the only way it can notice the shape on an address
 * nobody has published yet. Returns null unless the bytes are printable enough
 * to be deliberate.
 */
function decodeAddressEncodings(address) {
  const bytes = Buffer.from(address.slice(2), "hex");

  // The ASCII view, for the part of the address that carries a readable label.
  const printableBytes = [...bytes].filter((b) => b >= 0x20 && b <= 0x7e);
  const ascii = Buffer.from(printableBytes).toString("latin1");

  // The octet view. The IP is not written as digits: each byte IS an octet, so
  // 0xa6 0x58 0x86 0x3e is 166.88.134.62. Reading the address as text finds the
  // trailing label and misses the address the malware is actually there to
  // carry, which is the half that matters.
  const groups = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    groups.push({ offset: i, ip: [...bytes.subarray(i, i + 4)].join(".") });
  }
  const counts = new Map();
  for (const group of groups) counts.set(group.ip, (counts.get(group.ip) || 0) + 1);
  for (const group of groups) group.repeats = counts.get(group.ip);

  // Any 20-byte value renders as five IPv4-shaped strings, so the shape alone
  // says nothing. What marks the technique is corroboration: the same non-zero
  // group written twice, or a substantial printable label sharing the address
  // with it. Zero-filled groups are excluded because the burn address is
  // 16 zero bytes and would otherwise report a repeat on every transaction
  // that pays into it -- which is most of them.
  const repeatedNonZero = groups.some((g) => g.repeats > 1 && g.ip !== "0.0.0.0");
  const notable = printableBytes.length >= 12 || repeatedNonZero;
  return { ascii, printable: printableBytes.length, total: bytes.length, groups, notable };
}

/**
 * Query lines and matches for one address read as an encoded payload. Shared by
 * the address check and the transaction check, which need the same reading of a
 * recipient as of a candidate.
 */
function reportAddressEncoding(address, role, location, watchlistIps) {
  const queries = [];
  const matches = [];
  const decoded = decodeAddressEncodings(address);
  if (!decoded.notable) return { queries, matches };

  const repeated = decoded.groups.filter((g) => g.repeats > 1).map((g) => g.ip);
  queries.push(
    `${role} ${address} decodes to ${decoded.printable}/${decoded.total} printable bytes ` +
      `${JSON.stringify(decoded.ascii)}, and byte-wise to IPv4 ${decoded.groups.map((g) => g.ip).join(", ")}` +
      (repeated.length ? ` -- ${[...new Set(repeated)].join(", ")} written more than once` : "")
  );

  // One row per encoded address, not one per occurrence: an IP written twice
  // is the same finding said twice, and the repeat count is in the context.
  const reported = new Set();
  for (const group of decoded.groups) {
    const known = watchlistIps.find((e) => e.value === group.ip);
    if (!known || reported.has(known.id)) continue;
    reported.add(known.id);
    matches.push({
      ioc_id: known.id,
      matched_value: `${address} (bytes ${group.offset}-${group.offset + 3} as IPv4)`,
      location,
      matched_at: nowIso(),
      context:
        `bytes ${group.offset}-${group.offset + 3} of this address are ${group.ip}, watchlisted as ${known.id}` +
        (group.repeats > 1 ? `, and the same four bytes are repeated ${group.repeats} times in the address` : "") +
        (decoded.ascii ? `. The address also carries the printable label ${JSON.stringify(decoded.ascii)}` : "") +
        `. This is the NullReceiver encoding: the recipient address is the payload, so the transaction ` +
        `carrying it needs no calldata to inspect.`,
    });
  }
  return { queries, matches };
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

function loadWatchlist() {
  const raw = fs.readFileSync(WATCHLIST_PATH, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("etherhiding-watchlist.json must be a JSON array");
  }
  // Identifies the exact ruleset a run applied. A date would not: the file can
  // change twice in a day, and a findings file that cannot name what produced
  // it cannot be audited against the watchlist later.
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return {
    entries,
    version: `etherhiding-watchlist.json @ sha256:${digest} (${entries.length} entries)`,
  };
}

/**
 * Compiles a c2_pattern entry's `detection` block into something testable.
 * Entries without one are not silently skipped -- the caller reports them as
 * unevaluated, because a pattern the tool cannot apply must not look like a
 * pattern that was applied and did not fire.
 */
function compileDetections(entries) {
  const usable = [];
  const unevaluated = [];
  for (const entry of entries) {
    if (entry.ioc_type !== "c2_pattern") continue;
    const spec = entry.detection;
    if (!spec || !Array.isArray(spec.strings) || spec.strings.length === 0) {
      unevaluated.push(entry);
    } else if (spec.kind && spec.kind !== "all_of_strings") {
      unevaluated.push(entry);
    } else {
      usable.push(entry);
    }
  }
  return { usable, unevaluated };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Applies one compiled detection to one blob of retrieved text. Returns null
 * when any required condition fails -- every string in an all_of_strings spec
 * has to be present at its stated count, mirroring the AND in the published
 * YARA rule rather than firing on a single common substring.
 */
function testDetection(entry, text) {
  const spec = entry.detection;
  // max_bytes is an exclusive ceiling, matching YARA's `filesize < 10KB`.
  if (spec.max_bytes && Buffer.byteLength(text, "utf8") >= spec.max_bytes) return null;
  if (spec.not_starts_with && text.startsWith(spec.not_starts_with)) return null;

  const lowered = text.toLowerCase();
  const hits = [];
  for (const rule of spec.strings) {
    const found = rule.case_insensitive
      ? countOccurrences(lowered, rule.text.toLowerCase())
      : countOccurrences(text, rule.text);
    if (found < (rule.min_occurrences || 1)) return null;
    // A published rule can pin an exact count -- JADESNOW's requires `#s5 == 1`,
    // one occurrence of charAt and no more. Treating that as a floor would fire
    // on files the rule's author deliberately excluded.
    if (rule.max_occurrences && found > rule.max_occurrences) return null;
    hits.push(`${JSON.stringify(rule.text)} x${found}`);
  }
  return hits.join(", ");
}

// ---------------------------------------------------------------------------
// Candidate addresses
// ---------------------------------------------------------------------------

function normalizeAddress(value) {
  // EVM addresses are not case-sensitive at the protocol level, and EIP-55
  // checksum casing varies between reports, so everything is compared lowercase.
  return value.trim().toLowerCase();
}

function readAddressFile(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.split("#")[0].trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Chain access
// ---------------------------------------------------------------------------

let rpcRequestId = 0;

async function rpcOnce(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcRequestId, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

/**
 * One call against a chain, trying each endpoint given for it in turn.
 *
 * Public endpoints are not interchangeable and not reliable: one load-balances
 * across backends that disagree about which methods exist, another returns a
 * redirect mid-run, a third serves eth_getCode but not a lookup by sender and
 * nonce. Failing over across a list means a chain is covered if ANY of its
 * endpoints can answer, and it is what lets the resolver lookup use a capable
 * endpoint while ordinary reads use a stable one. Only the last error survives,
 * on the reasoning that a caller wants to know the call failed everywhere, not
 * to read four transport errors.
 */
async function rpc(endpoints, method, params) {
  const urls = Array.isArray(endpoints) ? endpoints : [endpoints];
  let lastError;
  for (const url of urls) {
    try {
      return await rpcOnce(url, method, params);
    } catch (err) {
      // A revert is the chain's own answer, so it outranks a later endpoint's
      // rate limit or transport error: keep it as the error that survives.
      if (!(lastError && /revert/i.test(lastError.message))) lastError = err;
    }
  }
  throw new Error(urls.length > 1 ? `${lastError.message} (all ${urls.length} endpoints for this chain failed)` : lastError.message);
}

/**
 * Fetches a verified ABI so the payload accessor can be called by its real name
 * instead of guessed at. Optional throughout: a failure here downgrades the
 * address to the guess list rather than aborting the run.
 */
async function fetchVerifiedGetters(explorer, key, address) {
  const url = new URL(explorer);
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getabi");
  url.searchParams.set("address", address);
  if (key) url.searchParams.set("apikey", key);

  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (payload.status !== "1" || !payload.result) {
    throw new Error(String(payload.result || payload.message || "no verified ABI"));
  }

  return JSON.parse(payload.result)
    .filter(
      (item) =>
        item.type === "function" &&
        (item.stateMutability === "view" || item.stateMutability === "pure" || item.constant) &&
        (item.inputs || []).length === 0
    )
    .map((item) => `${item.name}()`);
}

/**
 * Every outbound transaction an address has sent, from an indexer.
 *
 * Plain JSON-RPC cannot answer "what has this address done" -- it can fetch a
 * transaction you already name, and nothing else. That gap is why the resolver
 * check could only ever read the single most recent transaction and had to
 * guess at history. An indexer closes it, and the Etherscan-compatible txlist
 * shape is spoken by both Etherscan-family explorers and Blockscout, so one
 * code path covers a keyed API and a keyless public one.
 *
 * Returned rows are attacker-influenced data. Nothing here is executed, and the
 * caller re-reads anything it intends to act on from an RPC endpoint rather
 * than trusting the indexer's copy.
 */
async function enumerateOutbound(indexer, key, address) {
  const list = await enumerateTransactions(indexer, key, address);
  return list.filter((tx) => (tx.from || "").toLowerCase() === address.toLowerCase());
}

const INDEXER_SPACING_MS = 3000;
// The Etherscan-compatible txlist caps page times offset at 10,000.
const TXLIST_PAGE_SIZE = 10000;
// Spacing is kept per indexer, so a wait owed to one host never holds up another.
const lastIndexerCall = new Map();
// Indexers that answered "too many requests" during this run. They are tried
// last from then on: Blockscout throttled every Ethereum history read in CI,
// and backing off on each one before reaching Routescan, which answered at
// once, cost about 100 seconds a contract and most of the daily refresh.
const throttledIndexers = new Set();

/** Every transaction to or from an address, oldest first, from the first indexer that answers. */
async function enumerateTransactions(indexers, key, address) {
  const list = [].concat(indexers);
  const ordered = [...list.filter((i) => !throttledIndexers.has(i)), ...list.filter((i) => throttledIndexers.has(i))];
  let lastError;
  for (const [index, indexer] of ordered.entries()) {
    try {
      // Only the last indexer is worth waiting out; any other passes a throttled call on.
      return await enumerateFrom(indexer, key, address, index === ordered.length - 1);
    } catch (err) {
      if (err.throttled) throttledIndexers.add(indexer);
      lastError = err;
    }
  }
  throw lastError;
}

async function enumerateFrom(indexer, key, address, backoff = true) {
  const url = new URL(indexer);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("sort", "asc");
  // Without an explicit page size Routescan answers only the first 25 rows,
  // and a short list read as the whole history drops every later write.
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(TXLIST_PAGE_SIZE));
  if (key) url.searchParams.set("apikey", key);

  // Keyless indexers throttle hard and answer a burst with 429 or a
  // "Too many requests" body. Spacing every call out avoids most of it, and a
  // backoff clears the rest; a run that skips histories leaves C2 hosts
  // untied to their contracts on /etherhiding/.
  const host = url.host;
  let payload;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastIndexerCall.get(host) || 0) + INDEXER_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastIndexerCall.set(host, Date.now());
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) });
    payload = response.ok ? await response.json() : null;
    if (payload && Array.isArray(payload.result)) break;
    const throttled = response.status === 429 || /too many/i.test(String(payload && payload.message));
    if (throttled && !backoff) {
      throw Object.assign(new Error(`${host} is throttling (HTTP ${response.status})`), { throttled: true });
    }
    if (!throttled || attempt === 3) {
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000 * (attempt + 1)));
  }
  if (!Array.isArray(payload.result)) {
    throw new Error(String(payload.message || payload.result || "no transaction list returned"));
  }
  if (payload.result.length >= TXLIST_PAGE_SIZE) {
    throw new Error(`a full page of ${TXLIST_PAGE_SIZE} transactions came back, so the list may be cut short`);
  }
  return payload.result;
}

/**
 * A resolver wallet's history collapsed into the runs of one destination.
 *
 * The point of a resolver is that the answer changes, so the useful shape is
 * not a list of transactions but the sequence of addresses it has pointed at
 * and when. Consecutive payments to the same destination are one entry.
 */
function rotationTimeline(transactions) {
  const runs = [];
  for (const tx of transactions) {
    const to = (tx.to || "").toLowerCase();
    if (!ADDRESS_RE.test(to)) continue;
    const date = new Date(Number(tx.timeStamp) * 1000).toISOString().slice(0, 10);
    const last = runs[runs.length - 1];
    if (last && last.to === to) {
      last.until = date;
      last.count++;
      last.last_tx = tx.hash;
      continue;
    }
    const decoded = decodeAddressEncodings(to);
    // The same decoder the tracker uses: NullReceiver's repeated IP and the
    // IP-port-IP-port shape XCTDH writes, which the octet view above misses.
    const ips = decodedIps(to);
    runs.push({
      to,
      resolved_ip: ips[0] || null,
      ...(ips.length > 1 ? { resolved_ips: ips } : {}),
      label: decoded.notable ? decoded.ascii : null,
      from: date,
      until: date,
      count: 1,
      first_tx: tx.hash,
      last_tx: tx.hash,
    });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Turning returned bytes into inert text
// ---------------------------------------------------------------------------

/** Printable-ASCII runs embedded in a blob, which is where a stored payload shows up. */
function asciiRuns(buffer, minimumLength = 8) {
  const runs = [];
  let current = [];
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) {
      current.push(byte);
    } else {
      if (current.length >= minimumLength) runs.push(Buffer.from(current).toString("latin1"));
      current = [];
    }
  }
  if (current.length >= minimumLength) runs.push(Buffer.from(current).toString("latin1"));
  return runs;
}

/**
 * ABI-decodes a `string`/`bytes` return value, which arrives as a 32-byte
 * offset, a 32-byte length, then the data. Anything that does not fit that
 * layout falls through to the caller's ASCII scan rather than being forced.
 */
function decodeAbiString(buffer) {
  if (buffer.length < 64) return null;
  // Both fields are 32-byte big-endian words whose high 24 bytes are zero for
  // any real payload, so only the low 8 bytes need reading.
  const offset = Number(buffer.readBigUInt64BE(24));
  if (offset !== 32) return null;
  const length = Number(buffer.readBigUInt64BE(56));
  if (!Number.isSafeInteger(length) || length === 0 || 64 + length > buffer.length) return null;
  return buffer.subarray(64, 64 + length).toString("utf8");
}

/**
 * Every inert view of one returned value: the decoded string, the ASCII runs,
 * and base64 blobs decoded one level. Reported payloads are commonly stored
 * base64-encoded, so testing only the raw bytes would miss the pattern by
 * design. Decoding is one level and non-recursive, and the result is still only
 * ever string-matched.
 */
function derivedTexts(buffer) {
  const texts = [];
  const decoded = decodeAbiString(buffer);
  if (decoded) texts.push({ label: "abi-decoded string", text: decoded });

  const runs = asciiRuns(buffer);
  if (runs.length) texts.push({ label: "printable ASCII runs", text: runs.join("\n") });

  for (const source of [decoded, ...runs].filter(Boolean)) {
    for (const blob of source.match(/[A-Za-z0-9+/]{64,}={0,2}/g) || []) {
      const bytes = Buffer.from(blob, "base64");
      if (bytes.length > 32) {
        texts.push({
          label: `base64-decoded blob (${blob.length} chars)`,
          text: bytes.toString("utf8"),
        });
      }
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Mode 1: offline string match of candidates against watchlisted addresses. */
function matchAgainstWatchlist(candidates, entries) {
  const byValue = new Map();
  for (const entry of entries) {
    if (ADDRESS_TYPES.has(entry.ioc_type) && entry.value) {
      byValue.set(normalizeAddress(entry.value), entry);
    }
  }

  const matches = [];
  for (const candidate of candidates) {
    const entry = byValue.get(candidate);
    if (!entry) continue;
    matches.push({
      ioc_id: entry.id,
      matched_value: candidate,
      location: "offline watchlist comparison (no chain queried)",
      matched_at: nowIso(),
      context:
        `candidate address string-matched watchlist entry value ${entry.value} ` +
        `(${entry.malware_family || "unattributed"}, confidence ${entry.confidence_level || "unstated"})`,
    });
  }
  return matches;
}

/** The first block at which an address has code, by binary search. */
async function firstBlockWithCode(endpoint, address, headBlock) {
  let lo = 1;
  let hi = headBlock;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await rpc(endpoint, "eth_getCode", [address, `0x${mid.toString(16)}`]);
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function blockDate(endpoint, block) {
  const found = await rpc(endpoint, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  return found ? new Date(parseInt(found.timestamp, 16) * 1000).toISOString().slice(0, 19) : "(no timestamp)";
}

/** The transaction in a block that called a given contract, which for a payload write is the setter call. */
async function transactionTouching(endpoint, block, address) {
  const found = await rpc(endpoint, "eth_getBlockByNumber", [`0x${block.toString(16)}`, true]);
  if (!found || !Array.isArray(found.transactions)) return null;
  return found.transactions.find((tx) => (tx.to || "").toLowerCase() === address.toLowerCase()) || null;
}

/**
 * Mode 2 for one address: read its bytecode, read whatever its view methods
 * return, and test all of it against the compiled detections. Returns matches
 * plus the query log, including the queries that failed.
 */
/** The host of a URL a contract hands back, or null when it is not one. */
function hostOf(value) {
  try {
    return new URL(String(value).trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * EtherRAT's resolver: a contract holding mapping(address => string), where
 * each operator wallet writes its current C2 URL with setString(string) and
 * the implant reads it back with getString(operator) through eth_call. The
 * storage walk above cannot see it, because a mapping value lives at
 * keccak(key . slot) rather than in a numbered slot, and the selector probe
 * cannot reach it either, because the accessor takes an argument. So the
 * watchlist entry names its operators and this reads each one's value the way
 * the implant does.
 *
 * Operators also park the resolver on a bare well-known domain between
 * sessions, and the implant's current answer is often one of them. A value missing from the watchlist is therefore reported for review
 * and never treated as an indicator by this tool.
 */
async function readMappingC2(address, entry, options) {
  const { endpoint, at } = options;
  const queries = [];
  const mapping = [];
  const hosts = options.watchlistHosts || new Map();
  const getter = selectorFor("getString(address)");
  const setter = selectorFor("setString(string)");
  const operators = (entry.operators || []).map(normalizeAddress).filter((a) => ADDRESS_RE.test(a));

  for (const operator of operators) {
    let value = null;
    try {
      const result = await rpc(endpoint, "eth_call", [{ to: address, data: getter + operator.slice(2).padStart(64, "0") }, "latest"]);
      value = decodeAbiString(Buffer.from(String(result || "0x").slice(2), "hex"));
    } catch (err) {
      queries.push(`eth_call ${address} getString(${operator}) ${at} -- FAILED: ${err.message}`);
      continue;
    }
    mapping.push({ operator, value });
    const host = hostOf(value);
    const known = host && hosts.get(host);
    queries.push(
      `eth_call ${address} getString(${operator}) ${at} -- ${value ? JSON.stringify(value) : "empty"}` +
        (!host ? "" : known ? `, watchlisted as ${known}` : ` -- NOT IN WATCHLIST: the implant currently resolves to a host no entry carries. Operators also park the resolver on well-known domains between sessions, so this needs review before it is treated as an indicator.`)
    );
  }

  if (!options.indexer) return { queries, mapping };

  // The write history is the rotation: every setString call is the operator
  // moving the implant to a new host, and the indexer is the only way to list
  // them, since the contract emits no events.
  let writes;
  try {
    const list = await enumerateTransactions(options.indexer, options.explorerKey, address);
    writes = [];
    for (const tx of list) {
      if (!String(tx.input || "").toLowerCase().startsWith(setter)) continue;
      const value = decodeAbiString(Buffer.from(tx.input.slice(10), "hex"));
      const day = new Date(Number(tx.timeStamp) * 1000).toISOString().slice(0, 10);
      const last = writes[writes.length - 1];
      const from = String(tx.from).toLowerCase();
      if (last && last.value === value && last.from === from) {
        last.until = day;
        continue;
      }
      writes.push({ from, value, since: day, until: day, tx: tx.hash });
    }
  } catch (err) {
    queries.push(`indexer txlist for ${address} -- FAILED: ${err.message}; the write history was not read`);
    return { queries, mapping };
  }

  queries.push(`enumerated ${writes.length} setString write(s) to ${entry.id} via its indexer`);
  for (const write of writes) {
    const host = hostOf(write.value);
    const known = host && hosts.get(host);
    const writer = operators.includes(write.from) ? "" : ` by ${write.from}, a writer the watchlist does not name`;
    queries.push(
      `  ${write.since}${write.until !== write.since ? ` to ${write.until}` : ""}: ${JSON.stringify(write.value)}${writer}` +
        (host ? (known ? ` -- watchlisted as ${known}` : " -- NOT IN WATCHLIST") : "")
    );
  }
  const history = writes.map(({ from, value, since, until, tx }) => ({ from, value, since, until, tx }));
  return { queries, mapping, writes: writes.length, history };
}

async function inspectOnChain(address, options) {
  const { endpoint, chain, blockNumber, detections, explorer, explorerKey, entry } = options;
  const matches = [];
  const queries = [];
  const at = `on ${chain} at block ${blockNumber}`;

  // Every address gets read as ASCII, contract or not: NullReceiver hides its
  // C2 in the address itself, so this is the one check that does not depend on
  // there being any code or stored data to fetch.
  const encoded = reportAddressEncoding(address, "candidate", `address decode ${at}`, options.watchlistIps || []);
  queries.push(...encoded.queries);
  matches.push(...encoded.matches);

  let bytecode;
  try {
    bytecode = await rpc(endpoint, "eth_getCode", [address, "latest"]);
  } catch (err) {
    queries.push(`eth_getCode ${address} ${at} -- FAILED: ${err.message}`);
    return { matches, queries };
  }

  if (!bytecode || bytecode === "0x") {
    // An owner, deployer or recipient address is an EOA by definition, and
    // reporting "holds no contract" for one every run trains a reader to skim
    // past the line that would matter if a contract ever did appear there.
    const expectedEoa = entry && (entry.onchain_role === "owner_eoa" || entry.ioc_type === "wallet_address");
    queries.push(
      expectedEoa
        ? `eth_getCode ${address} ${at} -- empty bytecode, the expected result for ${entry.id} (recorded as an externally owned address, not a payload-hosting contract)`
        : `eth_getCode ${address} ${at} -- returned empty bytecode; the address holds no contract on this chain (an externally owned account, a self-destructed contract, or the wrong chain)`
    );

    // An operator's address is not inert just because it holds no code. Its
    // nonce is the count of transactions it has ever sent, so recording it each
    // run turns a static watchlist row into an activity signal: a hand that has
    // moved since the last check is the cheapest useful thing this tool can
    // notice, and it needs no API key to see.
    const observation = { id: entry ? entry.id : null, target: address, kind: "eoa", chain, block: blockNumber };
    try {
      observation.nonce = parseInt(await rpc(endpoint, "eth_getTransactionCount", [address, "latest"]), 16);
      observation.balance_wei = BigInt(await rpc(endpoint, "eth_getBalance", [address, "latest"])).toString();
      queries.push(
        `eth_getTransactionCount ${address} ${at} -- ${observation.nonce} transaction(s) sent, balance ${observation.balance_wei} wei`
      );
    } catch (err) {
      queries.push(`eth_getTransactionCount ${address} ${at} -- FAILED: ${err.message}`);
    }

    // Follow a resolver wallet to whatever it currently points at.
    //
    // This is the only part of the tool that can outrun its own watchlist. The
    // malware resolves its C2 by reading this wallet's most recent outbound
    // transaction, so reading the same transaction gives the address the
    // malware would use right now -- which is a live value, not the one that
    // happened to be current when a report was written. A rotation is invisible
    // to any static indicator list, and it is the whole reason this wallet is
    // worth watching rather than just recording.
    if (entry && entry.onchain_role === "resolver_wallet" && observation.nonce > 0) {
      // With an indexer, read the whole history rather than only the tip. The
      // rotation is the intelligence: a resolver that has pointed at three
      // addresses in six weeks says something no single reading of it can.
      let currentFromIndexer = null;
      if (options.indexer) {
        try {
          const history = await enumerateOutbound(options.indexer, options.explorerKey, address);
          const runs = rotationTimeline(history);
          observation.rotation = runs;
          queries.push(
            `enumerated ${history.length} outbound transaction(s) from ${entry.id} via its indexer -- ` +
              `${runs.length} distinct destination(s)`
          );
          for (const run of runs) {
            for (const ip of run.resolved_ips || (run.resolved_ip ? [run.resolved_ip] : [])) {
              const known = (options.watchlistIps || []).find((e) => e.value === ip);
              queries.push(
                `  ${run.from} to ${run.until}: ${run.to} resolves to ${ip}` +
                  `${run.label ? ` (label ${JSON.stringify(run.label)})` : ""}, ${run.count} transaction(s), ` +
                  `first ${run.first_tx} -- ${known ? `watchlisted as ${known.id}` : "NOT IN WATCHLIST"}`
              );
            }
          }
          // The last run is the wallet's newest outbound transaction, which is
          // what the malware resolves to now. Reading it here means the current
          // value no longer depends on eth_getTransactionBySenderAndNonce, which
          // most public endpoints refuse.
          const newest = runs[runs.length - 1];
          if (newest) currentFromIndexer = { nonce: observation.nonce - 1, tx: newest.last_tx, to: newest.to };
        } catch (err) {
          queries.push(`indexer txlist for ${address} -- FAILED: ${err.message}; falling back to the latest transaction only`);
        }
      }

      const latest = observation.nonce - 1;
      try {
        let tx = null;
        let source = "indexer txlist";
        if (currentFromIndexer) {
          tx = { hash: currentFromIndexer.tx, to: currentFromIndexer.to };
        } else {
          source = `eth_getTransactionBySenderAndNonce ${address} nonce ${latest}`;
          tx = await rpc(endpoint, "eth_getTransactionBySenderAndNonce", [address, `0x${latest.toString(16)}`]);
        }
        if (!tx || !tx.to) {
          queries.push(`${source} ${at} -- no transaction returned`);
        } else {
          const ips = decodedIps(tx.to);
          const current = ips[0] || null;
          observation.resolver = { nonce: latest, tx: tx.hash, to: tx.to, resolved_ip: current, ...(ips.length > 1 ? { resolved_ips: ips } : {}) };
          queries.push(
            `following ${entry.id}: its most recent outbound transaction (${tx.hash}, read from the ${source}) pays ` +
              `${tx.to}, which decodes to ${ips.length ? ips.join(" and ") : "no IP address"}. This is the address the malware would resolve to now.`
          );
          const unlisted = [];
          for (const ip of ips) {
            const known = (options.watchlistIps || []).find((e) => e.value === ip);
            if (known) {
              matches.push({
                ioc_id: known.id,
                matched_value: `${tx.to} (resolved from ${entry.id})`,
                location: `${source} ${at}`,
                matched_at: nowIso(),
                context:
                  `the resolver wallet's current outbound transaction points at ${ip}, which is watchlisted as ` +
                  `${known.id}. The published C2 is still the live one.`,
              });
            } else {
              unlisted.push(ip);
            }
          }
          if (unlisted.length) {
            // Not a match, because a match means the watchlist already knew.
            // This is the opposite: the watchlist is behind the operator.
            observation.resolver.unlisted = true;
            queries.push(
              `NOT IN WATCHLIST: ${unlisted.join(" and ")} (from recipient ${tx.to}) is what ${entry.id} currently resolves to, and no ` +
                `watchlist entry carries it. The published C2 for this technique is stale. This is an on-chain ` +
                `observation by this tool, not published reporting, and needs review before it is treated as an indicator.`
            );
          }
        }
      } catch (err) {
        // Most public endpoints do not serve this method. Saying so plainly
        // beats leaving a reader to assume the resolver was checked.
        queries.push(
          `eth_getTransactionBySenderAndNonce ${address} nonce ${latest} ${at} -- FAILED: ${err.message}. ` +
            `This chain's endpoint cannot look a transaction up by sender and nonce, so the resolver was not followed; ` +
            `supply an endpoint that supports the method to cover it.`
        );
      }
    }
    return { matches, queries, observation };
  }

  const codeBytes = Buffer.from(bytecode.slice(2), "hex");
  queries.push(`eth_getCode ${address} ${at} -- ${codeBytes.length} bytes of deployed bytecode`);

  const inspected = [{ source: `eth_getCode ${address}`, texts: derivedTexts(codeBytes) }];
  const observation = {
    id: entry ? entry.id : null,
    target: address,
    kind: "contract",
    chain,
    block: blockNumber,
    code_bytes: codeBytes.length,
    code_sha256: sha256(codeBytes),
  };

  if (entry && entry.onchain_role === "mapping_c2_contract") {
    const mapped = await readMappingC2(address, entry, { ...options, at });
    queries.push(...mapped.queries);
    observation.mapping = mapped.mapping;
    if (mapped.writes) observation.mapping_writes = mapped.writes;
    if (mapped.history) observation.mapping_history = mapped.history;
  }

  // Read the payload out of storage before probing for an accessor. Solidity's
  // layout for a long string is public, so the bytes can be read without an
  // ABI, without a method name, and even when the accessor takes arguments --
  // which is the case the selector probe cannot reach at all.
  let strings = [];
  try {
    strings = await readStorageStrings(
      (addr, slot) => rpc(endpoint, "eth_getStorageAt", [addr, slot, "latest"]),
      address
    );
    const stored = strings.filter((s) => s.bytes);
    for (const string of stored) {
      queries.push(
        `eth_getStorageAt ${address} slot ${string.slot} ${at} -- ${string.length.toLocaleString("en-US")}-byte stored string read from ${string.words} slot(s)`
      );
      inspected.push({ source: `storage slot ${string.slot} of ${address}`, texts: derivedTexts(string.bytes) });
    }
    const cover = strings.filter((s) => s.form === "short").map((s) => JSON.stringify(s.text));
    if (cover.length) queries.push(`${address} carries short storage strings ${cover.join(", ")}`);
    // A slot that could not be read is not an empty slot. Without this, a
    // rate-limited endpoint made a stored payload look absent and the next
    // comparison reported it as removed.
    const unread = strings.filter((s) => s.error && !s.bytes);
    for (const string of unread) {
      queries.push(`eth_getStorageAt ${address} slot ${string.slot} ${at} -- FAILED: ${string.error}`);
    }
    if (unread.length) observation.storage_incomplete = true;
  } catch (err) {
    queries.push(`eth_getStorageAt ${address} ${at} -- FAILED: ${err.message}`);
    observation.storage_incomplete = true;
  }

  // Three sources of selectors, best first: the contract's own dispatch table,
  // a verified ABI if an explorer was supplied, and the English guess list.
  // The dispatch table is authoritative and free, so the guess list is now only
  // there to put a name to a selector it recognises.
  const named = new Map();
  for (const signature of CANDIDATE_GETTERS) named.set(selectorFor(signature), signature);

  let verified = [];
  if (explorer) {
    try {
      verified = await fetchVerifiedGetters(explorer, explorerKey, address);
      for (const signature of verified) named.set(selectorFor(signature), signature);
      queries.push(`explorer getabi ${address} -- ${verified.length} zero-argument view/pure method(s) in the verified ABI`);
    } catch (err) {
      queries.push(`explorer getabi ${address} -- FAILED: ${err.message}; continuing without it`);
    }
  }

  const dispatch = selectorsFromBytecode(codeBytes);

  // How much this contract looks like a dead-drop resolver, and why. This is
  // the part that can say something about an address nobody has published:
  // the score describes structure, never intent, and the reasons travel with
  // it so a reviewer sees what drove the number.
  const shape = shapeScore({ strings, selectors: dispatch });
  observation.shape_score = shape.score;
  observation.shape_reasons = shape.reasons;
  if (shape.payload) {
    observation.payload = shape.payload;
    queries.push(
      `${address} scores ${shape.score}/100 on the dead-drop shape: ${shape.reasons.join("; ")}. ` +
        `Payload sha256 ${shape.payload.sha256}. The score describes structure and is not an attribution.`
    );
  } else {
    queries.push(`${address} scores ${shape.score}/100 on the dead-drop shape: ${shape.reasons.join("; ") || "no dead-drop indicators"}`);
  }

  // The write history, where an archive endpoint allows it. A dead drop's value
  // is not what it holds now but how it has been used, and nothing indexes
  // that -- the contract emits no events. Binary-searching archive state
  // recovers it anyway.
  if (options.history && shape.payload) {
    try {
      const deployed = await firstBlockWithCode(endpoint, address, options.headBlock);
      const writes = await walkPayloadWrites(
        (addr, slot, block) => rpc(endpoint, "eth_getStorageAt", [addr, slot, block]),
        address,
        shape.payload.slot,
        deployed,
        options.headBlock
      );
      observation.payload_writes = writes.length;
      queries.push(
        `payload write history for ${address}: deployed at block ${deployed.toLocaleString("en-US")}, ` +
          `${writes.length - 1} subsequent write(s) recovered by binary-searching archive state`
      );
      for (const write of writes) {
        const stamp = await blockDate(endpoint, write.block);
        let via = "";
        if (!write.initial) {
          const tx = await transactionTouching(endpoint, write.block, address);
          if (tx) via = `, set by ${tx.hash} (selector ${tx.input.slice(0, 10)}, ${((tx.input.length - 2) / 2).toLocaleString("en-US")} bytes of calldata) from ${tx.from}`;
        }
        queries.push(
          `  block ${write.block.toLocaleString("en-US")} ${stamp}: payload length ${write.length.toLocaleString("en-US")}` +
            `${write.initial ? " (at deployment)" : ""}${via}`
        );
      }
    } catch (err) {
      queries.push(`payload write history for ${address} -- FAILED: ${err.message}. An archive endpoint is needed to read old state.`);
    }
  }

  const probes = [];
  const queued = new Set();
  for (const selector of dispatch) {
    queued.add(selector);
    probes.push({ selector, origin: "bytecode dispatch table" });
  }
  for (const signature of [...verified, ...CANDIDATE_GETTERS]) {
    const selector = selectorFor(signature);
    if (queued.has(selector)) continue;
    queued.add(selector);
    probes.push({ selector, origin: verified.includes(signature) ? "verified ABI" : "guess list" });
  }
  const probeList = probes.slice(0, MAX_PROBES);
  queries.push(
    `probing ${address} ${at} with ${probeList.length} selector(s): ${dispatch.length} recovered from the ` +
      `deployed bytecode's dispatch table, the rest from ${verified.length ? "the verified ABI and " : ""}the guess list` +
      (probes.length > probeList.length ? ` (capped from ${probes.length})` : "")
  );

  let retrieved = 0;
  for (const { selector, origin } of probeList) {
    const label = named.has(selector) ? `${named.get(selector)} ${selector}` : `${selector} (unnamed, ${origin})`;
    let result;
    try {
      result = await rpc(endpoint, "eth_call", [{ to: address, data: selector }, "latest"]);
    } catch (err) {
      // A method that does not exist, or one that needs arguments, reverts.
      // That is the expected outcome for most of the list and is only worth a
      // line when the selector came from the contract's own dispatch table.
      // A transport failure is not a revert, and says nothing about arguments.
      if (!/revert/i.test(err.message)) {
        queries.push(`eth_call ${address} ${label} ${at} -- FAILED: ${err.message}`);
      } else if (origin === "bytecode dispatch table") {
        queries.push(`eth_call ${address} ${label} ${at} -- reverted: ${err.message} (likely takes arguments)`);
      }
      continue;
    }
    if (!result || result === "0x") continue;

    const returned = Buffer.from(result.slice(2), "hex");
    if (returned.length > MAX_RETURN_BYTES) {
      queries.push(
        `eth_call ${address} ${label} ${at} -- returned ${returned.length} bytes, over the ${MAX_RETURN_BYTES}-byte cap; not inspected`
      );
      continue;
    }
    queries.push(`eth_call ${address} ${label} ${at} -- returned ${returned.length} bytes`);
    inspected.push({ source: `eth_call ${address} ${label}`, texts: derivedTexts(returned) });
    retrieved++;
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }

  // Recorded explicitly: "the accessor was not found" and "the accessor was
  // found and held nothing that matched" are different outcomes, and a reader
  // who cannot tell them apart will read the first as the second.
  if (retrieved === 0) {
    queries.push(
      `no probed method on ${address} returned data -- only the deployed bytecode was available to inspect. ` +
        (dispatch.length
          ? `All ${dispatch.length} selector(s) in the contract's own dispatch table either reverted or returned empty, so any accessor still holding a payload takes arguments this tool does not know to supply.`
          : "No dispatch table could be recovered from the bytecode, which is unusual for a Solidity contract and may mean the payload is held by a proxy or a non-standard dispatcher.")
    );
  }

  const before = matches.length;
  for (const { source, texts } of inspected) {
    for (const { label, text } of texts) {
      for (const detection of detections) {
        const hits = testDetection(detection, text);
        if (!hits) continue;
        matches.push({
          ioc_id: detection.id,
          matched_value: `${address} (${label})`,
          location: `${source} ${at}`,
          matched_at: nowIso(),
          context:
            `retrieved contract data matched watchlist detection pattern ${detection.id}: ${hits}. ` +
            `The data was inspected as inert text and never executed.`,
        });
      }
    }
  }

  // Data was read and matched nothing. Say what it looked like anyway: the
  // published patterns describe the stage-one downloader that runs on a
  // victim's disk, not the blob a contract hands back, so "no match" here is
  // a weak statement and a reviewer needs more than the absence of a row.
  if (matches.length === before) {
    for (const { source, texts } of inspected) {
      if (texts.length) queries.push(`characterizing ${source} -- ${characterize(texts)}`);
    }
  }

  return { matches, queries, observation };
}

/**
 * One transaction: read its calldata and test that against the detections.
 *
 * The three Ethereum transactions GTIG lists as storing INVISIBLEFERRET
 * payloads hold 7 to 27 KB of calldata each, sent to the burn address. Nothing
 * about that is reachable through eth_getCode, which is why a contract-only
 * checker had never once looked at the place the payload is known to be.
 */
async function inspectTransaction(hash, options) {
  const { endpoint, chain, blockNumber, detections, entry } = options;
  const matches = [];
  const queries = [];
  const at = `on ${chain} at block ${blockNumber}`;

  let tx;
  try {
    tx = await rpc(endpoint, "eth_getTransactionByHash", [hash]);
  } catch (err) {
    queries.push(`eth_getTransactionByHash ${hash} ${at} -- FAILED: ${err.message}`);
    return { matches, queries };
  }
  if (!tx) {
    queries.push(
      `eth_getTransactionByHash ${hash} ${at} -- not found on this chain (wrong chain, or a node that has pruned it)`
    );
    return { matches, queries };
  }

  const input = Buffer.from((tx.input || "0x").slice(2), "hex");
  const value = BigInt(tx.value || "0x0");
  const observation = {
    id: entry ? entry.id : null,
    target: hash,
    kind: "transaction",
    chain,
    block: blockNumber,
    calldata_bytes: input.length,
    calldata_sha256: input.length ? sha256(input) : null,
    to: tx.to || null,
    from: tx.from || null,
  };
  queries.push(
    `eth_getTransactionByHash ${hash} ${at} -- from ${tx.from} to ${tx.to || "(contract creation)"}, ` +
      `value ${value === 0n ? "0" : value.toString()} wei, ${input.length.toLocaleString("en-US")} bytes of calldata`
  );

  // The NullReceiver shape, called out because it is the one that looks like
  // nothing: no calldata to scan and no value moved, with the address doing
  // all the work.
  if (input.length === 0 && value === 0n && tx.to) {
    queries.push(
      `${hash} carries zero value and zero calldata -- the NullReceiver shape, where the recipient address is the payload`
    );
    observation.nullreceiver_shape = true;
  }
  if (tx.to) {
    const encoded = reportAddressEncoding(
      tx.to,
      "recipient",
      `eth_getTransactionByHash ${hash} ${at}`,
      options.watchlistIps || []
    );
    queries.push(...encoded.queries);
    matches.push(...encoded.matches);
  }

  if (input.length === 0) return { matches, queries, observation };
  if (input.length > MAX_RETURN_BYTES) {
    queries.push(`${hash} calldata is ${input.length} bytes, over the ${MAX_RETURN_BYTES}-byte cap; not inspected`);
    return { matches, queries, observation };
  }

  const texts = derivedTexts(input);
  const before = matches.length;
  for (const { label, text } of texts) {
    for (const detection of detections) {
      const hits = testDetection(detection, text);
      if (!hits) continue;
      matches.push({
        ioc_id: detection.id,
        matched_value: `${hash} (${label})`,
        location: `eth_getTransactionByHash ${hash} ${at}`,
        matched_at: nowIso(),
        context:
          `transaction calldata matched watchlist detection pattern ${detection.id}: ${hits}. ` +
          `The data was inspected as inert text and never executed.`,
      });
    }
  }
  if (matches.length === before && texts.length) {
    queries.push(`characterizing calldata of ${hash}${entry ? ` (${entry.id})` : ""} -- ${characterize(texts)}`);
  }

  return { matches, queries, observation };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * What changed between two runs, ignoring the fields that move on every run.
 * Comparing whole files would report a change every time scan_id and ran_at
 * advance, which would make a scheduled pull request meaningless.
 */
function findingsSignature(result) {
  return JSON.stringify({
    ruleset_version: result.ruleset_version,
    matches: (result.matches || []).map((m) => [m.ioc_id, m.matched_value, m.context]),
    // Observations, not the query log. Every run's log names the block it read
    // at, so signing the log made "changed" mean "the chain advanced" -- true
    // of every run ever, and useless to a workflow deciding whether to open a
    // pull request. What should trigger one is the intelligence moving: a
    // payload rotated, code replaced, an operator's nonce advanced.
    observations: (result.observations || []).map((o) => [
      o.target,
      o.chain,
      o.code_sha256 || null,
      o.payload ? o.payload.sha256 : null,
      o.calldata_sha256 || null,
      o.nonce === undefined ? null : o.nonce,
      o.shape_score === undefined ? null : o.shape_score,
      o.mapping ? o.mapping.map((m) => [m.operator, m.value]) : null,
      // A pointer's writes are its only signal: each run, how many writes it
      // holds and the last one.
      ...(o.kind === "pointer" ? [(o.rotation || []).map((r) => [r.to, r.count, r.last_tx])] : []),
    ]),
  });
}

/**
 * Keyless indexers throttle, and a throttled history read must not erase the
 * history an earlier run recovered: /etherhiding/ builds each address's C2
 * timeline from it.
 */
function carryForwardHistory(previous, current) {
  const before = new Map((previous || []).map((o) => [`${o.chain}:${o.target}`, o]));
  for (const now of current) {
    const then = before.get(`${now.chain}:${now.target}`);
    if (!then) continue;
    for (const field of ["mapping_history", "rotation"]) {
      if (!now[field] && then[field]) now[field] = then[field];
    }
  }
}

/**
 * What moved between the previous run and this one.
 *
 * This is the difference between a checker and a tracker. A dead-drop resolver
 * exists to be rewritten -- the operator pays a small fee and the payload
 * changes, with no domain to re-register and nothing for a static indicator
 * list to notice. Comparing content hashes run over run is the only way this
 * site can see that happen, and a rotation date is intelligence that no
 * citation can supply because it has not happened yet when the report is
 * written.
 */
function diffObservations(previous, current) {
  const changes = [];
  const before = new Map((previous || []).map((o) => [`${o.chain}:${o.target}`, o]));

  for (const now of current) {
    const key = `${now.chain}:${now.target}`;
    const then = before.get(key);
    if (!then) {
      changes.push({ target: now.target, chain: now.chain, change: "first observation", detail: "no previous run recorded this target on this chain" });
      continue;
    }
    if (now.payload && then.payload && now.payload.sha256 !== then.payload.sha256) {
      changes.push({
        target: now.target,
        chain: now.chain,
        change: "payload rotated",
        detail:
          `stored payload changed from sha256 ${then.payload.sha256} (${then.payload.bytes} bytes) to ` +
          `${now.payload.sha256} (${now.payload.bytes} bytes) between the previous run and this one`,
      });
    }
    if (now.payload && !then.payload) {
      changes.push({ target: now.target, chain: now.chain, change: "payload appeared", detail: `a ${now.payload.bytes}-byte stored payload is present where the previous run found none` });
    }
    if (!now.payload && then.payload && !now.storage_incomplete) {
      changes.push({ target: now.target, chain: now.chain, change: "payload removed", detail: `the ${then.payload.bytes}-byte stored payload the previous run read is gone` });
    }
    if (now.code_sha256 && then.code_sha256 && now.code_sha256 !== then.code_sha256) {
      changes.push({ target: now.target, chain: now.chain, change: "bytecode replaced", detail: `deployed code changed from sha256 ${then.code_sha256} to ${now.code_sha256}` });
    }
    for (const current of now.mapping || []) {
      const earlier = (then.mapping || []).find((m) => m.operator === current.operator);
      if (earlier && earlier.value !== current.value) {
        changes.push({
          target: now.target,
          chain: now.chain,
          change: "C2 rotated",
          detail: `getString(${current.operator}) changed from ${JSON.stringify(earlier.value)} to ${JSON.stringify(current.value)} between the previous run and this one`,
        });
      }
    }
    if (now.kind === "pointer" && now.rotation && then.rotation) {
      const writes = (obs) => obs.rotation.reduce((n, r) => n + r.count, 0);
      const last = now.rotation[now.rotation.length - 1];
      if (writes(now) !== writes(then) && last) {
        changes.push({
          target: now.target,
          chain: now.chain,
          change: "operator activity",
          detail:
            `pointer wrote ${writes(now) - writes(then)} new transaction(s) since the previous run; it now names BSC transaction ` +
            `${last.to} (last write ${last.until}, ${last.last_tx})`,
        });
      }
    }
    if (typeof now.nonce === "number" && typeof then.nonce === "number" && now.nonce !== then.nonce) {
      changes.push({
        target: now.target,
        chain: now.chain,
        change: "operator activity",
        detail: `nonce advanced from ${then.nonce} to ${now.nonce}, so this address sent ${now.nonce - then.nonce} transaction(s) since the previous run`,
      });
    }
  }
  return changes;
}

function writeFindings(result, dryRun) {
  let previous = null;
  if (fs.existsSync(FINDINGS_PATH)) {
    try {
      previous = JSON.parse(fs.readFileSync(FINDINGS_PATH, "utf8"));
    } catch {
      previous = null;
    }
  }
  const changed = !previous || findingsSignature(previous) !== findingsSignature(result);

  if (dryRun) {
    console.log(JSON.stringify(result, null, 2));
    console.log("\n--dry-run: src/_data/etherhidingFindings/latest.json was not written.");
    return changed;
  }

  fs.mkdirSync(path.dirname(FINDINGS_PATH), { recursive: true });
  writeFileAtomic(FINDINGS_PATH, JSON.stringify(result, null, 2) + "\n");
  return changed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/check-etherhiding-contracts.js --address <0x...> [--address <0x...>]
  node scripts/check-etherhiding-contracts.js --file <path>
  node scripts/check-etherhiding-contracts.js --refresh --rpc <url>

Options:
  --address <0x...>   Candidate address to check. Repeatable.
  --tx <0x...>        Candidate transaction hash, read for its calldata. Repeatable.
  --file <path>       File of candidate addresses, one per line ('#' comments allowed).
  --refresh           Mode 3: re-check every watchlisted address and transaction. Requires --rpc.
  --rpc <url>         JSON-RPC endpoint. Enables the live on-chain check (mode 2).
                      Repeatable, and accepts "<chain>=<url>" to cover a watchlist
                      spanning chains in one run, e.g.
                        --rpc bsc=https://... --rpc ethereum=https://...
                      Also read from ETHERHIDING_RPC_URL.
  --chain <label>     Chain label for endpoints given without one (default: the RPC host).
  --history           Walk each watchlisted contract's payload write history by
                      binary-searching archive state. Needs an endpoint that serves
                      eth_getStorageAt at old blocks; recovers the rotation history
                      on a chain with no reachable transaction-list API.
  --indexer <url>     Transaction-list API for a chain, "<chain>=<url>". Etherscan-
                      compatible txlist shape; Blockscout serves it without a key,
                      e.g. ethereum=https://eth.blockscout.com/api. Enables the full
                      resolver rotation history rather than its latest entry alone.
                      Repeat it for a chain to add fallbacks, tried in order when
                      one is throttled (Routescan serves the same shape keyless).
  --explorer <url>    Block-explorer API base, e.g. https://api.bscscan.com/api.
                      Optional: selectors are recovered from bytecode without it.
                      Also read from ETHERHIDING_EXPLORER_URL.
  --explorer-key <k>  Explorer API key. Also read from ETHERHIDING_EXPLORER_KEY.
  --dry-run           Print the findings file instead of writing it.

Without --rpc this runs mode 1 only: an offline string match, no network access.`;

function parseArgs(argv) {
  const args = { addresses: [], txHashes: [], rpcs: [], indexers: [], refresh: false, history: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--address": args.addresses.push(next()); break;
      case "--tx": args.txHashes.push(next()); break;
      case "--file": args.addresses.push(...readAddressFile(next())); break;
      case "--refresh": args.refresh = true; break;
      case "--rpc": args.rpcs.push(next()); break;
      case "--chain": args.chain = next(); break;
      case "--explorer": args.explorer = next(); break;
      case "--indexer": args.indexers.push(next()); break;
      case "--history": args.history = true; break;
      case "--explorer-key": args.explorerKey = next(); break;
      case "--dry-run": args.dryRun = true; break;
      case "--help":
      case "-h": args.help = true; break;
      default: throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (!args.rpcs.length && process.env.ETHERHIDING_RPC_URL) args.rpcs.push(process.env.ETHERHIDING_RPC_URL);
  args.explorer = args.explorer || process.env.ETHERHIDING_EXPLORER_URL || null;
  args.explorerKey = args.explorerKey || process.env.ETHERHIDING_EXPLORER_KEY || null;

  // A watchlist spanning two chains needs two endpoints, so each one carries
  // its own chain label. "bsc=https://..." names it outright; a bare URL falls
  // back to --chain, then to the host, which is what a single-chain run has
  // always done.
  const grouped = new Map();
  for (const spec of args.rpcs) {
    const labelled = /^([A-Za-z0-9_-]+)=(https?:\/\/.+)$/.exec(spec);
    const chain = labelled ? labelled[1].toLowerCase() : (args.chain || new URL(spec).host).toLowerCase();
    const url = labelled ? labelled[2] : spec;
    if (!grouped.has(chain)) grouped.set(chain, []);
    grouped.get(chain).push(url);
  }
  args.endpoints = [...grouped].map(([chain, urls]) => ({ chain, urls }));

  // Same "<chain>=<url>" shape as --rpc. An indexer answers what an address has
  // done, which no JSON-RPC endpoint can.
  args.indexerFor = new Map();
  for (const spec of args.indexers) {
    const labelled = /^([A-Za-z0-9_-]+)=(https?:\/\/.+)$/.exec(spec);
    const chain = labelled ? labelled[1].toLowerCase() : (args.chain || new URL(spec).host).toLowerCase();
    // A chain may name several; they are tried in order, so a throttled
    // keyless indexer falls back to the next.
    args.indexerFor.set(chain, [...(args.indexerFor.get(chain) || []), labelled ? labelled[2] : spec]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return false;
  }
  if (!args.refresh && args.addresses.length === 0 && args.txHashes.length === 0) {
    throw new Error(`no candidates supplied.\n\n${USAGE}`);
  }
  // The design's scope boundary: modes 2 and 3 need infrastructure the site
  // owner supplies, and mode 3 has nothing to do without it.
  if (args.refresh && !args.endpoints.length) {
    throw new Error(
      "--refresh re-reads live chain data and needs an endpoint.\n" +
        "Supply --rpc <url> or set ETHERHIDING_RPC_URL. No endpoint is bundled with this repo."
    );
  }

  keccakSelfTest();
  const { entries, version } = loadWatchlist();
  const { usable, unevaluated } = compileDetections(entries);
  // TRON and Aptos pointer accounts are not EVM addresses; they are read from
  // their own APIs below, whichever chains --rpc covers.
  const pointerEntries = entries.filter(isPointerEntry);
  const watchlisted = entries.filter((e) => ADDRESS_TYPES.has(e.ioc_type) && !isPointerEntry(e));
  const watchlistedTx = entries.filter((e) => TX_HASH_TYPES.has(e.ioc_type));
  const watchlistIps = entries.filter((e) => e.ioc_type === "ip_address");
  // Hosts a mapping contract can hand back, keyed to the entry that carries
  // them, so a resolved C2 can be named as known or flagged as new.
  const watchlistHosts = new Map();
  for (const e of entries) {
    if (e.ioc_type === "domain" || e.ioc_type === "ip_address") watchlistHosts.set(String(e.value).toLowerCase(), e.id);
    if (e.ioc_type === "url") {
      const host = hostOf(e.value);
      if (host && !watchlistHosts.has(host)) watchlistHosts.set(host, e.id);
    }
  }

  const queries = [];
  const observations = [];
  const chains = new Set(args.endpoints.map((e) => e.chain));

  // Every watchlisted target, tagged with the entry it came from so the run can
  // say which indicator a query belongs to and can tell an owner address's
  // empty bytecode apart from a contract that has gone quiet.
  const targets = [];
  const rejected = [];
  if (args.refresh) {
    for (const entry of [...watchlisted, ...watchlistedTx]) {
      const isTx = TX_HASH_TYPES.has(entry.ioc_type);
      const value = isTx ? entry.value.toLowerCase() : normalizeAddress(entry.value);
      if (!(isTx ? TX_HASH_RE : ADDRESS_RE).test(value)) {
        rejected.push(entry.value);
        continue;
      }
      // An entry recorded on a chain nobody supplied an endpoint for is not
      // checked, and saying so beats reporting it as absent from the one chain
      // that was queried.
      if (entry.chain && !chains.has(entry.chain)) {
        queries.push(
          `watchlist entry ${entry.id} (${entry.value}) was NOT re-checked -- it is recorded on chain ` +
            `"${entry.chain}" and this run queried ${[...chains].map((c) => `"${c}"`).join(", ")}. ` +
            `Re-run with that chain's endpoint to cover it.`
        );
        continue;
      }
      targets.push({ value, isTx, entry, chain: entry.chain || null });
    }
  } else {
    for (const raw of args.addresses) {
      const address = normalizeAddress(raw);
      if (!ADDRESS_RE.test(address)) rejected.push(raw);
      else if (!targets.some((t) => t.value === address)) targets.push({ value: address, isTx: false, entry: null, chain: null });
    }
    for (const raw of args.txHashes) {
      const hash = String(raw).trim().toLowerCase();
      if (!TX_HASH_RE.test(hash)) rejected.push(raw);
      else if (!targets.some((t) => t.value === hash)) targets.push({ value: hash, isTx: true, entry: null, chain: null });
    }
  }
  if (targets.length === 0) {
    throw new Error("no well-formed EVM addresses or transaction hashes among the candidates");
  }

  for (const raw of rejected) {
    queries.push(`skipped ${JSON.stringify(raw)} -- not a well-formed EVM address or transaction hash`);
  }
  for (const entry of unevaluated) {
    queries.push(
      `watchlist entry ${entry.id} (c2_pattern) was NOT evaluated -- it carries no machine-readable "detection" block, so its published pattern can only be applied by hand`
    );
  }

  // Mode 3 seeds its candidates from the watchlist itself, so an offline
  // self-match would report every entry matching itself. Only the live check
  // says anything there.
  const addressValues = targets.filter((t) => !t.isTx).map((t) => t.value);
  const matches = args.refresh ? [] : matchAgainstWatchlist(addressValues, entries);
  if (!args.refresh) {
    queries.push(
      `offline watchlist comparison of ${addressValues.length} candidate address(es) against ${watchlisted.length} watchlisted address(es)`
    );
  }

  const mode = args.refresh
    ? "3 (watchlist freshness re-check)"
    : args.endpoints.length
      ? "2 (live chain data check)"
      : "1 (offline watchlist match)";

  if (args.endpoints.length) {
    if (usable.length === 0) {
      queries.push(
        "no c2_pattern entry carries a machine-readable detection block, so chain data was retrieved but could not be pattern-tested"
      );
    }

    for (const endpoint of args.endpoints) {
      let blockNumber;
      try {
        blockNumber = parseInt(await rpc(endpoint.urls, "eth_blockNumber", []), 16).toLocaleString("en-US");
      } catch (err) {
        // One unreachable endpoint must not discard the chains that answered.
        queries.push(`eth_blockNumber on ${endpoint.chain} (${endpoint.urls.length} endpoint(s)) -- FAILED: ${err.message}; no target was checked on this chain`);
        continue;
      }
      queries.push(`eth_blockNumber on ${endpoint.chain} -- head at block ${blockNumber}`);

      // A target recorded on a chain goes only to that chain's endpoint; one
      // supplied by hand has no chain, so it is tried on all of them.
      const forChain = targets.filter((t) => !t.chain || t.chain === endpoint.chain);
      for (const target of forChain) {
        const options = {
          endpoint: endpoint.urls,
          chain: endpoint.chain,
          blockNumber,
          detections: usable,
          explorer: args.explorer,
          explorerKey: args.explorerKey,
          entry: target.entry,
          watchlistIps,
          watchlistHosts,
          indexer: args.indexerFor.get(endpoint.chain) || null,
          history: args.history,
          headBlock: Number(String(blockNumber).replace(/,/g, "")),
        };
        const outcome = target.isTx
          ? await inspectTransaction(target.value, options)
          : await inspectOnChain(target.value, options);
        matches.push(...outcome.matches);
        queries.push(...outcome.queries);
        if (outcome.observation) observations.push(outcome.observation);
      }
    }
  } else {
    queries.push(
      "no RPC endpoint supplied -- mode 1 only. No chain data was read, so no c2_pattern entry was tested against live on-chain data."
    );
  }

  if (args.refresh) {
    const pointers = await readPointers(pointerEntries);
    queries.push(...pointers.queries);
    observations.push(...pointers.observations);
  }

  // The previous run, for comparison. A missing or unreadable file just means
  // every target reads as a first observation, which is the honest answer.
  let previousObservations = [];
  if (fs.existsSync(FINDINGS_PATH)) {
    try {
      previousObservations = JSON.parse(fs.readFileSync(FINDINGS_PATH, "utf8")).observations || [];
    } catch {
      previousObservations = [];
    }
  }
  keepPrunedRuns(previousObservations, observations);
  const changes = diffObservations(previousObservations, observations);
  carryForwardHistory(previousObservations, observations);

  const ranAt = nowIso();
  const result = {
    scan_id: `etherhiding-${ranAt.replace(/:/g, "-")}-${crypto.randomBytes(3).toString("hex")}`,
    ran_at: ranAt,
    ruleset_version: version,
    matches,
    changes,
    observations,
    queries_executed: queries,
    status_note:
      `Mode ${mode}. Checked ${targets.filter((t) => !t.isTx).length} address(es) and ${targets.filter((t) => t.isTx).length} ` +
      `transaction(s) against ${entries.length} watchlist ` +
      `entries; ${matches.length} match(es). A match means the candidate appears in publicly cited reporting, or ` +
      `that data read from it matched a published detection pattern. It is not a determination that the contract ` +
      `is currently malicious, and every row requires manual review against the cited source and the present state ` +
      `of the contract.`,
  };

  const changed = writeFindings(result, args.dryRun);
  console.log(`Mode ${mode}, ${targets.length} target(s), ${matches.length} match(es), ${changes.length} change(s).`);
  for (const match of matches) {
    console.log(`  + ${match.ioc_id} -- ${match.matched_value}`);
  }
  for (const change of changes) {
    console.log(`  ~ ${change.change}: ${change.target} on ${change.chain}`);
  }
  if (!args.dryRun) console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  return changed;
}

// Guarded so the matching logic can be exercised directly, which is the only
// way to check that a detection block fires without an obliging malicious
// contract to point the tool at.
if (require.main === module) {
  main()
    .then((changed) => {
      console.log(`CHANGED=${changed}`);
    })
    .catch((err) => {
      console.error(`Check failed: ${err.message}`);
      console.log("CHANGED=false");
      process.exitCode = 1;
    });
}

module.exports = {
  compileDetections,
  testDetection,
  decodeAbiString,
  derivedTexts,
  selectorsFromBytecode,
  decodeAddressEncodings,
  rotationTimeline,
  enumerateTransactions,
  shannonEntropy,
};
