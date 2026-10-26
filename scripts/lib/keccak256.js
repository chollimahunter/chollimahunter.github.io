/**
 * keccak256.js
 * ==============================================================
 * Ethereum's keccak256, used by scripts/check-etherhiding-contracts.js to turn
 * a view-method signature into the 4-byte selector an `eth_call` needs.
 *
 * Node's built-in crypto cannot do this. `crypto.createHash("sha3-256")` is
 * NIST SHA-3, which differs from Ethereum's keccak256 in exactly one byte --
 * the domain-separation padding (0x06 vs 0x01) -- and therefore produces a
 * completely different digest. Calling a contract with a selector derived from
 * SHA-3 would silently invoke the wrong method, or no method at all, so the
 * original Keccak padding is implemented here rather than approximated.
 *
 * Correctness is pinned by the published test vectors in selfTest() below.
 * Inputs are method signatures of a few dozen bytes, so the BigInt lane
 * arithmetic -- slower than a 32-bit split, and far easier to verify by eye --
 * costs nothing that matters here.
 */

const MASK = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1600-bit state minus the 512-bit capacity, in bytes.

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl(value, shift) {
  if (shift === 0n) return value;
  return ((value << shift) | (value >> (64n - shift))) & MASK;
}

/** Keccak-f[1600]: 24 rounds of theta, rho+pi, chi, iota over 25 64-bit lanes. */
function permute(lanes) {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) lanes[x + 5 * y] ^= d;
    }

    // rho and pi, walked as the single 24-step lane cycle from the Keccak spec
    let x = 1;
    let y = 0;
    let current = lanes[1];
    for (let t = 0; t < 24; t++) {
      const nextX = y;
      const nextY = (2 * x + 3 * y) % 5;
      const index = nextX + 5 * nextY;
      const held = lanes[index];
      lanes[index] = rotl(current, BigInt((((t + 1) * (t + 2)) / 2) % 64));
      current = held;
      x = nextX;
      y = nextY;
    }

    // chi
    for (let row = 0; row < 5; row++) {
      const base = 5 * row;
      const t0 = lanes[base], t1 = lanes[base + 1], t2 = lanes[base + 2];
      const t3 = lanes[base + 3], t4 = lanes[base + 4];
      lanes[base] = t0 ^ ((t1 ^ MASK) & t2);
      lanes[base + 1] = t1 ^ ((t2 ^ MASK) & t3);
      lanes[base + 2] = t2 ^ ((t3 ^ MASK) & t4);
      lanes[base + 3] = t3 ^ ((t4 ^ MASK) & t0);
      lanes[base + 4] = t4 ^ ((t0 ^ MASK) & t1);
    }

    // iota
    lanes[0] ^= ROUND_CONSTANTS[round];
  }
}

/**
 * @param {Buffer|string} input UTF-8 string or raw bytes.
 * @returns {Buffer} the 32-byte digest.
 */
function keccak256(input) {
  const message = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");

  // Pad10*1 with the original Keccak domain byte (0x01), not SHA-3's 0x06.
  const padded = Buffer.alloc(Math.ceil((message.length + 1) / RATE_BYTES) * RATE_BYTES);
  message.copy(padded);
  padded[message.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const lanes = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      lanes[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
    }
    permute(lanes);
  }

  const digest = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane++) {
    digest.writeBigUInt64LE(lanes[lane], lane * 8);
  }
  return digest;
}

/** The 4-byte function selector for a canonical signature, e.g. "get()". */
function selectorFor(signature) {
  return "0x" + keccak256(signature).subarray(0, 4).toString("hex");
}

/**
 * Published Keccak-256 vectors. A wrong digest here means every selector this
 * module produces is wrong, so callers run it before touching the network
 * rather than discovering it as an empty eth_call result.
 */
function selfTest() {
  const cases = [
    ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  ];
  for (const [input, expected] of cases) {
    const actual = keccak256(input).toString("hex");
    if (actual !== expected) {
      throw new Error(`keccak256(${JSON.stringify(input)}) = ${actual}, expected ${expected}`);
    }
  }
  // The ERC-20 transfer selector, the most widely published 4-byte value there is.
  if (selectorFor("transfer(address,uint256)") !== "0xa9059cbb") {
    throw new Error("keccak256 selector derivation failed the ERC-20 transfer vector");
  }
}

module.exports = { keccak256, selectorFor, selfTest };
