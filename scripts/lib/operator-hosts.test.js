/**
 * operator-hosts.test.js — host matching behind the isOperatorSite filter and
 * the operator-site-linked rule in scripts/check-site.js. Run with
 * `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { operatorHosts, isOperatorHost } = require("./operator-hosts.js");

const hosts = new Set(
  operatorHosts([
    { ioc_type: "domain", value: "blocknovas.com" },
    { ioc_type: "hosted_site", value: "0927.vercel.app" },
    { ioc_type: "hosted_site", value: "vercel.app" },
    { ioc_type: "personal_site", value: "https://brent-jeremy.github.io/" },
    { ioc_type: "personal_site", value: "about.me/urichoi" },
    { ioc_type: "github_profile", value: "https://github.com/someone" },
    { ioc_type: "domain", value: "t.me" },
  ])
);

test("operatorHosts keeps the full host a record names and nothing broader", () => {
  assert.deepEqual([...hosts].sort(), ["0927.vercel.app", "blocknovas.com", "brent-jeremy.github.io"]);
});

test("isOperatorHost matches exact hosts, with or without www. and scheme", () => {
  for (const [label, input, expected] of [
    ["bare host", "blocknovas.com", true],
    ["https URL with path", "https://blocknovas.com/careers?x=1", true],
    ["www. variant", "https://www.blocknovas.com/", true],
    ["upper case", "HTTPS://BlockNovas.com", true],
    ["hosted subdomain", "https://0927.vercel.app/api", true],
    ["subdomain not indexed", "https://mail.blocknovas.com/", false],
    ["platform apex", "https://vercel.app/", false],
    ["another project on the apex", "https://other.vercel.app/", false],
    ["platform account", "https://github.com/someone", false],
    ["profile path on a platform", "https://about.me/urichoi", false],
    ["malformed", "https://%%%", false],
    ["empty", "", false],
    ["not a string", null, false],
    ["mailto", "mailto:hr@blocknovas.com", false],
    ["javascript", "javascript:alert(1)", false],
  ]) {
    assert.equal(isOperatorHost(hosts, input), expected, label);
  }
});
