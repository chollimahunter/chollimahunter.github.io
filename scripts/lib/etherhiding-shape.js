/**
 * etherhiding-shape.js -- reading a dead drop, and recognising one
 * ==========================================================================
 * The checker this supports began as a watchlist re-checker: it asked whether
 * a published address was still there. That can only ever confirm what someone
 * else already found. These are the two things that let it say something new.
 *
 * READING. A payload sits in contract storage, and Solidity's layout for a
 * long string is public: the declared slot holds `2 * length + 1`, and the
 * bytes live in consecutive slots starting at keccak256(slot). Reading it that
 * way needs no ABI, no accessor name, and no explorer API key, and it still
 * works when the accessor takes arguments, is internal, or the contract never
 * exposed one. Probing guessed method names was the fragile way to do this.
 *
 * RECOGNISING. The published detection patterns describe the stage-one
 * JavaScript downloader that runs on a victim's disk. Nothing in them matches
 * what a contract hands back, which is why a checker built on them alone
 * cannot recognise a dead drop it has not been told about. What is recognisable
 * is the shape: a contract holding kilobytes of high-entropy base64 in a
 * storage string, usually behind an owner-gated setter so the operator can
 * rotate it. That shape is a description of a technique, not an attribution to
 * anyone, and this module is careful to report it as one.
 *
 * Nothing here executes retrieved data. Storage words are inspected as inert
 * bytes, the same rule the checker itself is built on.
 */

const crypto = require("crypto");
const { keccak256 } = require("./keccak256.js");

/** Slots scanned when looking for stored strings. Payload slots in observed contracts sit well inside this. */
const DEFAULT_MAX_SLOT = 16;

/** A stored string has to reach this to be a plausible payload rather than a name or a symbol. */
const PAYLOAD_MIN_BYTES = 512;

/** Ceiling on one stored string, so a corrupt length cannot turn into thousands of RPC calls. */
const MAX_STRING_BYTES = 512_000;

const ZERO_WORD = `0x${"0".repeat(64)}`;

function slotKey(slot) {
  const word = Buffer.alloc(32);
  word.writeUInt32BE(slot, 28);
  return BigInt(`0x${Buffer.from(keccak256(word)).toString("hex")}`);
}

/**
 * Every string held in the first `maxSlot` storage slots.
 *
 * Solidity packs a string under 32 bytes into the slot itself with `2 * length`
 * in the low byte, and stores a longer one out of line with `2 * length + 1` in
 * the slot. Both are read here: the short form catches the decoy token's name
 * and symbol, the long form catches the payload.
 */
async function readStorageStrings(readSlot, address, maxSlot = DEFAULT_MAX_SLOT) {
  const strings = [];
  for (let slot = 0; slot <= maxSlot; slot++) {
    let word;
    try {
      word = await readSlot(address, `0x${slot.toString(16)}`);
    } catch (err) {
      strings.push({ slot, error: err.message });
      continue;
    }
    if (!word || word === ZERO_WORD) continue;

    const raw = BigInt(word);
    // The length lives in the LOW byte for both forms, and only the long form
    // uses the whole word as 2 * length + 1. Reading a short string's length
    // off the full word instead of its low byte yields an astronomical number
    // and drops the string entirely -- which is what hid the decoy token's
    // name and symbol on the first run.
    const lowByte = raw & 0xffn;
    const isLong = (lowByte & 1n) === 1n;
    const length = isLong ? Number(raw >> 1n) : Number(lowByte >> 1n);
    if (!Number.isSafeInteger(length) || length === 0) continue;

    if (!isLong) {
      // Short form: the bytes are in the slot itself, ahead of the length byte.
      if (length > 31) continue;
      const text = Buffer.from(word.slice(2, 2 + length * 2), "hex").toString("latin1");
      if (/^[\x20-\x7e]+$/.test(text)) strings.push({ slot, form: "short", length, text });
      continue;
    }

    if (length > MAX_STRING_BYTES) {
      strings.push({ slot, form: "long", length, error: `declared length ${length} over the ${MAX_STRING_BYTES}-byte cap; not read` });
      continue;
    }

    const base = slotKey(slot);
    const words = Math.ceil(length / 32);
    const chunks = [];
    let failed = null;
    for (let i = 0; i < words; i++) {
      try {
        const value = await readSlot(address, `0x${(base + BigInt(i)).toString(16)}`);
        chunks.push(Buffer.from(value.slice(2), "hex"));
      } catch (err) {
        failed = err.message;
        break;
      }
    }
    if (failed) {
      strings.push({ slot, form: "long", length, error: failed });
      continue;
    }
    const bytes = Buffer.concat(chunks).subarray(0, length);
    strings.push({ slot, form: "long", length, bytes, text: bytes.toString("latin1"), words });
  }
  return strings;
}

/** Bits of entropy per byte. Near 8 is random or encrypted; prose and code sit near 4 to 5. */
function entropy(bytes) {
  if (!bytes.length) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of bytes) counts[byte]++;
  let total = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / bytes.length;
    total -= p * Math.log2(p);
  }
  return total;
}

function base64Ratio(text) {
  if (!text.length) return 0;
  let hits = 0;
  for (const char of text) {
    if (/[A-Za-z0-9+/=]/.test(char)) hits++;
  }
  return hits / text.length;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * How much a contract looks like a dead-drop resolver, and why.
 *
 * Deliberately a description of structure, never of intent. A contract can hold
 * a large encoded string for entirely ordinary reasons -- on-chain SVG art and
 * data URIs both look like this -- so a high score is a reason to look, and the
 * reasons are returned alongside it so a reviewer can see what drove the number
 * rather than being handed a verdict.
 */
function shapeScore({ strings, selectors }) {
  const reasons = [];
  let score = 0;

  const payloads = strings.filter((s) => s.bytes && s.length >= PAYLOAD_MIN_BYTES);
  const largest = payloads.sort((a, b) => b.length - a.length)[0] || null;

  if (largest) {
    score += 40;
    reasons.push(`stores a ${largest.length.toLocaleString("en-US")}-byte string in slot ${largest.slot}`);

    const ratio = base64Ratio(largest.text);
    if (ratio > 0.9) {
      score += 25;
      reasons.push(`that string is ${(ratio * 100).toFixed(1)}% base64 characters`);

      const decoded = Buffer.from(largest.text.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
      const bits = entropy(decoded);
      if (bits > 6) {
        score += 20;
        reasons.push(`it decodes to ${decoded.length.toLocaleString("en-US")} bytes at ${bits.toFixed(2)} bits/byte, so the payload is encoded rather than readable`);
      }
    }
  }

  // owner() plus a state-changing setter is the rotation mechanism: whoever
  // holds the key can replace the payload for a transaction fee, which is the
  // property the technique exists for.
  if (selectors.includes("0x8da5cb5b")) {
    score += 10;
    reasons.push("exposes owner(), the gate on a rotatable payload");
  }
  // A name and a symbol on a contract whose real content is a payload string is
  // cover: it reads as an ordinary token to anyone glancing at an explorer.
  const shortStrings = strings.filter((s) => s.form === "short");
  if (largest && shortStrings.length >= 2) {
    score += 5;
    reasons.push(`carries token-shaped cover strings (${shortStrings.map((s) => JSON.stringify(s.text)).join(", ")})`);
  }

  return {
    score,
    reasons,
    payload: largest
      ? {
          slot: largest.slot,
          bytes: largest.length,
          sha256: sha256(largest.bytes),
          base64_ratio: Number(base64Ratio(largest.text).toFixed(3)),
        }
      : null,
  };
}


/**
 * Every block at which a contract's stored payload changed.
 *
 * A dead drop's value is not what it holds now but how it has been used, and
 * that history is on chain even though nothing indexes it: `eth_getStorageAt`
 * takes a block, so the first word of the payload can be read at any height an
 * archive node still keeps. Binary-searching for the blocks where that word
 * changes recovers the write history without an indexer, an explorer key, or
 * event logs the contract never emitted -- which matters for BSC, where no
 * keyless transaction-list API was reachable at all.
 *
 * Each step costs about log2(range) reads, so a decade of blocks is roughly 25
 * calls per write found. `maxWrites` bounds the walk rather than the range.
 */
async function walkPayloadWrites(readSlotAt, address, slot, fromBlock, toBlock, maxWrites = 40) {
  const dataSlot = `0x${slotKey(slot).toString(16)}`;
  // Block heights go over the wire as hex quantities, not decimal numbers.
  const height = (block) => (typeof block === "number" ? `0x${block.toString(16)}` : block);
  const headAt = async (block) => (await readSlotAt(address, dataSlot, height(block))).slice(0, 34);
  const lengthAt = async (block) => {
    const word = await readSlotAt(address, `0x${slot.toString(16)}`, height(block));
    const raw = BigInt(word);
    return (raw & 1n) === 1n ? Number(raw >> 1n) : Number((raw & 0xffn) >> 1n);
  };

  // Identity is the payload's first word AND its length. Watching the first
  // word alone misses a rewrite that happens to keep its opening bytes, which
  // is not hypothetical here: the operator reuses an encoder, so consecutive
  // payloads can share a prefix and differ only in length.
  const stateAt = async (block) => `${await headAt(block)}:${await lengthAt(block)}`;

  const writes = [{ block: fromBlock, head: await headAt(fromBlock), length: await lengthAt(fromBlock), initial: true }];
  let current = fromBlock;
  let value = await stateAt(fromBlock);

  for (let found = 0; found < maxWrites; found++) {
    if ((await stateAt(toBlock)) === value) break;
    let lo = current + 1;
    let hi = toBlock;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await stateAt(mid)) === value) lo = mid + 1;
      else hi = mid;
    }
    current = lo;
    value = await stateAt(current);
    writes.push({ block: current, head: await headAt(current), length: await lengthAt(current) });
  }
  return writes;
}

module.exports = {
  walkPayloadWrites,
  readStorageStrings,
  shapeScore,
  entropy,
  base64Ratio,
  sha256,
  slotKey,
  PAYLOAD_MIN_BYTES,
};
