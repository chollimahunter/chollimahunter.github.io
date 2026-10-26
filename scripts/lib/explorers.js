"use strict";

/**
 * The public block-explorer page for an address or a transaction, so a reader
 * can see a C2 value where it sits on-chain. Explorers are third-party sites,
 * not operator infrastructure, so these render as ordinary links. A chain
 * with no entry here gets no link (null), never a guess.
 */
const EXPLORERS = {
  ethereum: { address: (v) => `https://etherscan.io/address/${v}`, tx: (v) => `https://etherscan.io/tx/${v}` },
  bsc: { address: (v) => `https://bscscan.com/address/${v}`, tx: (v) => `https://bscscan.com/tx/${v}` },
  polygon: { address: (v) => `https://polygonscan.com/address/${v}`, tx: (v) => `https://polygonscan.com/tx/${v}` },
  sepolia: { address: (v) => `https://sepolia.etherscan.io/address/${v}`, tx: (v) => `https://sepolia.etherscan.io/tx/${v}` },
  tron: {
    address: (v) => (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v) ? `https://tronscan.org/#/address/${v}` : `https://tronscan.org/#/transaction/${v}`),
    tx: (v) => `https://tronscan.org/#/transaction/${String(v).replace(/^0x/, "")}`,
  },
  aptos: {
    address: (v) => `https://explorer.aptoslabs.com/account/${v}?network=mainnet`,
    tx: (v) => `https://explorer.aptoslabs.com/txn/${v}?network=mainnet`,
  },
};

const NAMES = { ethereum: "Etherscan", bsc: "BscScan", polygon: "Polygonscan", sepolia: "Sepolia Etherscan", tron: "Tronscan", aptos: "Aptos Explorer" };

function explorerUrl(value, chain, kind = "address") {
  const explorer = EXPLORERS[String(chain || "").toLowerCase()];
  if (!explorer || !value || !explorer[kind]) return null;
  return explorer[kind](String(value));
}

function explorerName(chain) {
  return NAMES[String(chain || "").toLowerCase()] || null;
}

module.exports = { explorerUrl, explorerName };
