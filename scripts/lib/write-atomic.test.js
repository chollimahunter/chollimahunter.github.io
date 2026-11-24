"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renameWithRetry } = require("./write-atomic.js");

const fail = (code) => Object.assign(new Error(code), { code });

test("a rename blocked by a transient lock is retried until it succeeds", () => {
  let calls = 0;
  renameWithRetry("a", "b", 8, () => {
    if (++calls < 3) throw fail("EPERM");
  });
  assert.equal(calls, 3);
});

test("a lock that never clears, or any other error, is thrown", () => {
  let calls = 0;
  assert.throws(() => renameWithRetry("a", "b", 3, () => { calls++; throw fail("EBUSY"); }), { code: "EBUSY" });
  assert.equal(calls, 3);
  calls = 0;
  assert.throws(() => renameWithRetry("a", "b", 3, () => { calls++; throw fail("ENOENT"); }), { code: "ENOENT" });
  assert.equal(calls, 1);
});
