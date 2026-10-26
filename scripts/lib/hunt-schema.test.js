"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { huntSchemaProblems } = require("./hunt-schema.js");

const valid = () => ({
  platforms: ["Windows", "macOS"],
  logic: [
    "Collect: process starts on Windows and macOS endpoints",
    "Match: image is a remote-access client",
    "Exclude: devices in the IT-support group",
    "Report: devices with 2 or more distinct products",
  ],
  queries: [
    {
      platform: "Defender / Sentinel KQL",
      language: "kql",
      origin: "authored",
      query: "DeviceProcessEvents | take 1",
      note: "Each row is a device running more than one remote-access product.",
      tuning: [{ part: "the caffeinate match", reason: "benign on macOS", remove: "delete that entry from the Images list" }],
    },
    { platform: "Sigma", language: "yaml", origin: "authored", query: "title: x", note: "Fires on one launch.", tuning: [] },
  ],
});

const fieldsOf = (hunt) => huntSchemaProblems(hunt).map((p) => p.field);

test("a valid hunt has no problems", () => {
  assert.deepStrictEqual(huntSchemaProblems(valid()), []);
});

const variants = {
  "platforms missing": [(h) => delete h.platforms, "platforms"],
  "platforms empty": [(h) => (h.platforms = []), "platforms"],
  "platforms unknown value": [(h) => (h.platforms = ["Windows", "BSD"]), "platforms[1]"],
  "logic missing": [(h) => delete h.logic, "logic"],
  "logic too short": [(h) => (h.logic = h.logic.slice(0, 1)), "logic"],
  "logic too long": [(h) => (h.logic = [...h.logic, "Match: a", "Match: b", "Match: c"]), "logic"],
  "logic line over 140 characters": [(h) => (h.logic[1] = "Match: " + "x".repeat(140)), "logic[1]"],
  "logic bad prefix": [(h) => (h.logic[2] = "Ignore: devices"), "logic[2]"],
  "logic without Match": [(h) => (h.logic[1] = "Exclude: nothing"), "logic"],
  "logic without Report": [(h) => (h.logic[3] = "Exclude: nothing"), "logic"],
  "query platform outside the vocabulary": [(h) => (h.queries[0].platform = "Defender KQL (Windows)"), "queries[0].platform"],
  "query platform repeated": [(h) => (h.queries[1].platform = "Defender / Sentinel KQL"), "queries[1].platform"],
  "language does not match platform": [(h) => (h.queries[0].language = "spl"), "queries[0].language"],
  "note missing": [(h) => delete h.queries[0].note, "queries[0].note"],
  "note is three sentences": [(h) => (h.queries[0].note = "One. Two. Three."), "queries[0].note"],
  "tuning missing": [(h) => delete h.queries[0].tuning, "queries[0].tuning"],
  "tuning part empty": [(h) => (h.queries[0].tuning[0].part = ""), "queries[0].tuning[0].part"],
  "tuning reason missing": [(h) => delete h.queries[0].tuning[0].reason, "queries[0].tuning[0].reason"],
  "tuning remove empty": [(h) => (h.queries[0].tuning[0].remove = "  "), "queries[0].tuning[0].remove"],
};

for (const [name, [mutate, field]] of Object.entries(variants)) {
  test(`rejects: ${name}`, () => {
    const h = valid();
    mutate(h);
    assert.ok(fieldsOf(h).includes(field), `expected a finding on ${field}, got ${JSON.stringify(fieldsOf(h))}`);
  });
}

test("accepts Elastic with esql or eql, and Shodan / Censys with text", () => {
  const h = valid();
  h.queries = [
    { platform: "Elastic", language: "eql", note: "Ok.", tuning: [] },
    { platform: "Shodan / Censys", language: "text", note: "Ok.", tuning: [] },
  ];
  assert.deepStrictEqual(huntSchemaProblems(h), []);
  h.queries[0].language = "esql";
  assert.deepStrictEqual(huntSchemaProblems(h), []);
});
