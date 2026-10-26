#!/usr/bin/env node
/**
 * seal-private-lists.js — keep withheld values out of the public repository.
 *
 * Two lists name values the site deliberately does not index: the per-source
 * `exclude` entries in src/_data/iocs/scrape-sources.json and the cross-source
 * false positives in scripts/data/false-positives.json. Most of those values
 * belong to uninvolved people, so the public files carry only a sealed hash of
 * each (scripts/lib/private-data.js) and the readable entry, with its reason,
 * lives in the private `_drafts/private/` checkout:
 *
 *   _drafts/private/exclusions.json       { sources: { <url>: [{ value, reason }] } }
 *   _drafts/private/false-positives.json  { values: [{ value, ioc_type, reason }] }
 *
 * Add a withheld value to the private file (or, as before, as `{ value,
 * reason }` in the public one) and run `npm run seal`: every readable entry
 * found in a public file is moved to the private file, and every private entry
 * is written to the public file as `{ sealed }`. `npm run validate` fails while
 * any public entry is still readable.
 */
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { hasPrivateData, privatePath, readPrivateJson, seal } = require("./lib/private-data.js");

const ROOT = path.join(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "src", "_data", "iocs", "scrape-sources.json");
const FALSE_POSITIVE_PATH = path.join(__dirname, "data", "false-positives.json");

const writeJson = (file, data, indent = 2) => writeFileAtomic(file, JSON.stringify(data, null, indent) + "\n");

function sealExclusions() {
  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const store = readPrivateJson("exclusions.json", { sources: {} });
  let moved = 0;
  for (const source of config.sources || []) {
    for (const entry of source.exclude || []) {
      if (entry.value === undefined) continue;
      const list = (store.sources[source.url] = store.sources[source.url] || []);
      if (!list.some((e) => seal(e.value) === seal(entry.value))) list.push({ value: entry.value, reason: entry.reason });
      moved += 1;
    }
  }
  for (const source of config.sources || []) {
    const readable = store.sources[source.url] || [];
    const sealed = new Set((source.exclude || []).filter((e) => e.sealed).map((e) => e.sealed));
    for (const entry of readable) sealed.add(seal(entry.value));
    if (sealed.size) source.exclude = [...sealed].sort().map((hash) => ({ sealed: hash }));
  }
  return { config, store, moved };
}

function sealFalsePositives() {
  const doc = JSON.parse(fs.readFileSync(FALSE_POSITIVE_PATH, "utf8"));
  const store = readPrivateJson("false-positives.json", { values: [] });
  let moved = 0;
  for (const entry of doc.values || []) {
    if (entry.value === undefined) continue;
    if (!store.values.some((e) => seal(e.value) === seal(entry.value))) store.values.push(entry);
    moved += 1;
  }
  const sealed = new Set((doc.values || []).filter((e) => e.sealed).map((e) => e.sealed));
  for (const entry of store.values) sealed.add(seal(entry.value));
  doc._comment =
    "Values judged to be false positives, so the judgement is not re-made and the value never re-enters the index: scripts/ingest-scraped-iocs.js prunes them on every run. Sealed: each entry is a hash of the value, never the value, because a false positive is usually somebody who has done nothing. See scripts/seal-private-lists.js.";
  doc.values = [...sealed].sort().map((hash) => ({ sealed: hash }));
  return { doc, store, moved };
}

function main() {
  const exclusions = sealExclusions();
  const falsePositives = sealFalsePositives();
  const moved = exclusions.moved + falsePositives.moved;
  if (moved && !hasPrivateData()) {
    console.error(`${moved} readable withheld values found, but there is no _drafts/private/ to move them to. Nothing written.`);
    process.exit(1);
  }
  if (moved) {
    exclusions.store._comment = "Readable per-source exclusions; the public scrape-sources.json carries only their sealed hashes. See scripts/seal-private-lists.js.";
    falsePositives.store._comment = "Readable false positives; the public scripts/data/false-positives.json carries only their sealed hashes. See scripts/seal-private-lists.js.";
    writeJson(privatePath("exclusions.json"), exclusions.store);
    writeJson(privatePath("false-positives.json"), falsePositives.store);
  }
  writeJson(SOURCES_PATH, exclusions.config);
  writeJson(FALSE_POSITIVE_PATH, falsePositives.doc);
  console.log(`sealed: moved ${exclusions.moved} exclusions and ${falsePositives.moved} false positives to _drafts/private/`);
}

main();
