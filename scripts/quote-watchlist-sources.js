#!/usr/bin/env node
/**
 * quote-watchlist-sources.js — the source's own words for each EtherHiding value
 * ==========================================================================
 * Every entry in src/_data/iocs/etherhiding-watchlist.json carries a curated
 * description, which explains the value but is not what the source printed.
 * This reads each cited page and stores, on that citation, the passage that
 * names the value (`sources[].quote`), so the indicator page can show it as
 * printed with the value highlighted.
 *
 * A value is looked for as stored, then without its 0x prefix, then, for a
 * hex address or hash, by its leading 32, 24 or 16 characters: reports often
 * quote only a fragment ("a sender containing 33ff3eda..."). The passage is
 * the line around the first hit, cut to about 400 characters at word breaks.
 *
 * Block explorers are skipped (a transaction page is the evidence itself, not
 * prose about it), as are citations that already carry a quote, unless
 * --refresh is given. A value the page does not print is left unquoted and
 * listed at the end.
 *
 *   node scripts/quote-watchlist-sources.js            # unquoted citations only
 *   node scripts/quote-watchlist-sources.js --refresh  # every citation again
 */
const path = require("path");
const { fetchPage, readPage } = require("./scrape-dprk-iocs.js");
const { writeFileAtomic } = require("./lib/write-atomic.js");

const FILE = path.join(__dirname, "..", "src", "_data", "iocs", "etherhiding-watchlist.json");
const EXPLORERS = /(^|\.)(etherscan\.io|bscscan\.com|tronscan\.org|polygonscan\.com|arbiscan\.io|basescan\.org|blockchair\.com|solscan\.io|tonviewer\.com|explorer\.aptoslabs\.com)$/i;
const QUOTE_MAX = 400;

function candidates(value) {
  const v = String(value);
  const out = [v];
  const bare = v.replace(/^0x/i, "");
  if (bare !== v) out.push(bare);
  if (/^[0-9a-f]{32,}$/i.test(bare)) for (const n of [32, 24, 16]) if (bare.length > n) out.push(bare.slice(0, n));
  return out;
}

function quoteAround(text, value) {
  const lower = text.toLowerCase();
  for (const needle of candidates(value)) {
    const at = lower.indexOf(needle.toLowerCase());
    if (at === -1) continue;
    const start = text.lastIndexOf("\n", at) + 1;
    let end = text.indexOf("\n", at);
    if (end === -1) end = text.length;
    let from = start;
    let to = end;
    if (to - from > QUOTE_MAX) {
      const half = Math.floor((QUOTE_MAX - needle.length) / 2);
      from = Math.max(start, at - half);
      to = Math.min(end, at + needle.length + half);
      if (from > start) from = text.indexOf(" ", from) + 1 || from;
      if (to < end) to = text.lastIndexOf(" ", to) > at + needle.length ? text.lastIndexOf(" ", to) : to;
    }
    const body = text.slice(from, to).replace(/\s+/g, " ").trim();
    return (from > start ? "… " : "") + body + (to < end ? " …" : "");
  }
  return "";
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  const entries = require(FILE);
  const pages = new Map();
  const misses = [];
  let added = 0;

  const wanted = new Set();
  for (const entry of entries) {
    for (const source of entry.sources || []) {
      if (!source.url || (source.quote && !refresh)) continue;
      let host = "";
      try { host = new URL(source.url).hostname; } catch { continue; }
      if (EXPLORERS.test(host)) continue;
      wanted.add(source.url);
    }
  }

  for (const url of wanted) {
    try {
      const page = await fetchPage(url);
      pages.set(url, page && page.body ? readPage(page, url).text : null);
    } catch (err) {
      pages.set(url, null);
      console.error(`fetch failed: ${url} (${err.message})`);
    }
  }

  for (const entry of entries) {
    for (const source of entry.sources || []) {
      if (!wanted.has(source.url)) continue;
      const text = pages.get(source.url);
      if (!text) continue;
      const quote = quoteAround(text, entry.value);
      if (quote) {
        if (quote !== source.quote) added += 1;
        source.quote = quote;
      } else {
        misses.push(`${entry.id}  ${source.url}`);
      }
    }
  }

  writeFileAtomic(FILE, JSON.stringify(entries, null, 2) + "\n");
  console.log(`${wanted.size} pages read, ${added} quotes written, ${misses.length} citations where the page does not print the value`);
  for (const line of misses) console.log(`  not printed: ${line}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { quoteAround, candidates };
