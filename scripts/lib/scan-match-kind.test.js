/**
 * scan-match-kind.test.js — table-driven tests for scripts/lib/scan-match-kind.js
 * ==========================================================================
 * True positives are the repositories and paths the module's comments name;
 * false positives are words that carry a token inside them. Run with
 * `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { scanMatchKind } = require("./scan-match-kind.js");

const at = (repo, file) => ({ location: `https://github.com/${repo}/blob/0123abc/${file}` });

test("scanMatchKind classes detection tooling and indicator sets as research", () => {
  for (const [label, repo, file] of [
    ["IoCs repository name", "JPCERTCC/Contagious-Interview-IoCs", "ioc.txt"],
    ["IOC- path prefix", "someone/notes", "IOC-HUB/README.md"],
    ["iocs.json", "someone/app", "src/iocs.json"],
    ["YARA ruleset", "someone/yara-rules", "dprk/beavertail.yar"],
    ["camelCase YARA", "100DaysofYARA/2026", "RustyNoob619/Day54.yara"],
    ["cleanup scanner", "meSingh/polinrider-cleaner", "ioc/network.txt"],
    ["camelCase scanner", "branch8/PolinRiderScanner", "README-OFFICIAL.md"],
    ["IOC after a hump", "elgfind/itest3", "AdhocCheckIOC.csv"],
    ["samples directory", "rodhayl/VSCodeAntivir", "samples/stage1/package.json"],
    ["fixtures directory", "someone/app", "test/fixtures/bad.js"],
    ["rule file under rules/", "someone/app", "rules/dprk.yml"],
    ["indicators file", "Dragon-Lady/notes", "data/indicators.json"],
    ["underscore bound", "sand5066/hunting", "RF_IOC_09_05.txt"],
  ]) {
    assert.equal(scanMatchKind(at(repo, file)), "research", label);
  }
});

test("scanMatchKind leaves application code unclassed", () => {
  for (const [label, repo, file] of [
    ["ioc inside audioconverter", "someone/audioconverter", "src/index.js"],
    ["ioc inside social", "someone/social-app", "package.json"],
    ["poc inside a word", "someone/epoch-tracker", "src/epochs.js"],
    ["rules inside a word", "someone/app", "src/rulesengine.js"],
    ["sample inside a word", "someone/app", "src/resampler.js"],
    ["ci config .yml outside rules/", "someone/app", ".github/workflows/ci.yml"],
    ["test directory", "someone/app", "frontend_test/package.json"],
  ]) {
    assert.equal(scanMatchKind(at(repo, file)), null, label);
  }
});

test("scanMatchKind returns null for anything that is not a blob URL", () => {
  assert.equal(scanMatchKind(null), null);
  assert.equal(scanMatchKind({ location: "https://example.com/iocs.txt" }), null);
  assert.equal(scanMatchKind({}), null);
});
