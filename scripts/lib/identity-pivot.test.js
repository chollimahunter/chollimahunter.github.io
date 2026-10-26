"use strict";
const test = require("node:test");
const assert = require("node:assert");
const p = require("./identity-pivot.js");

test("noreply detection and id extraction", () => {
  assert.ok(p.isNoreply("123+Foo@users.noreply.github.com"));
  assert.ok(!p.isNoreply("a@example.com"));
  assert.deepStrictEqual(p.noreplyIdentity("123+Foo@users.noreply.github.com"), { id: 123, login: "foo" });
  assert.strictEqual(p.noreplyIdentity("foo@users.noreply.github.com"), null);
});

test("commits are kept only when author.login matches", () => {
  const commits = [
    { sha: "a".repeat(40), author: { login: "Foo" }, commit: { author: { name: "Foo Bar", email: "X@Example.com" } } },
    { sha: "b".repeat(40), author: { login: "other" }, commit: { author: { name: "Not Me", email: "n@e.com" } } },
    { sha: "c".repeat(40), author: { login: "foo" }, commit: { author: { name: "Foo", email: "9+foo@users.noreply.github.com" } } },
    { sha: "d".repeat(40), author: { login: "foo" }, commit: { author: { name: "Foo", email: "foo@users.noreply.github.com" } } },
  ];
  const r = p.identitiesFromCommits(commits, "foo", "foo/r");
  assert.deepStrictEqual([...r.emails.keys()], ["x@example.com"]);
  assert.deepStrictEqual([...r.names.keys()].sort(), ["Foo", "Foo Bar"]);
  assert.deepStrictEqual([...r.noreplyIds.keys()], ["9+foo@users.noreply.github.com"]);
  assert.strictEqual(r.emails.get("x@example.com")[0].repo, "foo/r");
});

test("events read PushEvent commits only", () => {
  const events = [
    { type: "WatchEvent", repo: { name: "a/b" } },
    { type: "PushEvent", repo: { name: "foo/r" }, payload: { commits: [{ sha: "1".repeat(40), author: { name: "N", email: "n@x.io" } }] } },
  ];
  const r = p.identitiesFromEvents(events);
  assert.deepStrictEqual([...r.emails.keys()], ["n@x.io"]);
});

test("otherLogins excludes self and dedupes", () => {
  const items = [
    { sha: "a", author: { login: "foo" }, repository: { full_name: "foo/r" } },
    { sha: "b", author: { login: "Bar" }, repository: { full_name: "bar/r" } },
    { sha: "c", author: { login: "Bar" }, repository: { full_name: "bar/s" } },
    { sha: "d", author: null, repository: { full_name: "z/z" } },
  ];
  assert.deepStrictEqual([...p.otherLogins(items, "FOO").keys()], ["Bar"]);
});

test("parseInclude and backoffSeconds", () => {
  const r = p.parseInclude('HTTP/2.0 403 Forbidden\r\nRetry-After: 12\r\nX-Ratelimit-Remaining: 0\r\n\r\n{"message":"x"}');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.headers["retry-after"], "12");
  assert.strictEqual(p.backoffSeconds(r.headers), 12);
  assert.strictEqual(p.backoffSeconds({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "110" }, 100), 11);
  assert.strictEqual(p.backoffSeconds({}), 60);
});
