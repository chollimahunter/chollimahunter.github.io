const test = require("node:test");
const assert = require("node:assert");
const { hasDomain, hasIp, hasWallet, filenameMatches, containsToken, isTokenType } = require("./token-match.js");

test("domain: the hostname or a subdomain of it, never a lookalike", () => {
  assert.ok(hasDomain('fetch("https://foo.com/api")', "foo.com"));
  assert.ok(hasDomain("host=foo.com:8080", "foo.com"));
  assert.ok(hasDomain("see api.foo.com.", "api.foo.com"));
  assert.ok(hasDomain("HTTP://FOO.COM", "foo.com"));
  assert.ok(hasDomain("https://sub.foo.com/x", "foo.com"));
  assert.ok(hasDomain("https://www.foo.com", "foo.com"));
  assert.ok(!hasDomain("https://evilfoo.com/x", "foo.com"));
  assert.ok(!hasDomain("https://evil-foo.com/x", "foo.com"));
  assert.ok(!hasDomain("https://foo.com.au/x", "foo.com"));
  assert.ok(!hasDomain("https://foo.com-cdn.net", "foo.com"));
  assert.ok(!hasDomain("https://fooxcom", "foo.com"));
});

test("ip: not inside a longer address", () => {
  assert.ok(hasIp("connect 1.2.3.4:443", "1.2.3.4"));
  assert.ok(hasIp('"1.2.3.4"', "1.2.3.4"));
  assert.ok(hasIp("ip=1.2.3.4.", "1.2.3.4"));
  assert.ok(!hasIp("11.2.3.45", "1.2.3.4"));
  assert.ok(!hasIp("1.2.3.45", "1.2.3.4"));
  assert.ok(!hasIp("21.2.3.4", "1.2.3.4"));
  assert.ok(!hasIp("1.2.3.4.5", "1.2.3.4"));
  assert.ok(!hasIp("9.1.2.3.4", "1.2.3.4"));
});

test("wallet: exact token; case-sensitive except 0x hex", () => {
  const b58 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
  assert.ok(hasWallet(`addr="${b58}";`, b58));
  assert.ok(!hasWallet(`addr="${b58.toLowerCase()}";`, b58));
  assert.ok(!hasWallet(`x${b58}`, b58));
  assert.ok(!hasWallet(`${b58}9`, b58));
  const hex = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
  assert.ok(hasWallet(`"${hex.toLowerCase()}"`, hex));
  assert.ok(!hasWallet(`${hex}ff`, hex));
});

test("filename: basename equality, case-insensitive", () => {
  assert.ok(filenameMatches("a/b/Run.BAT", "run.bat"));
  assert.ok(!filenameMatches("a/b/rerun.bat", "run.bat"));
  assert.ok(!filenameMatches("a/run.bat.txt", "run.bat"));
  assert.ok(filenameMatches("x/b.msi", "a.dmg / b.msi"));
  assert.ok(filenameMatches("x/vendor/run-update.sh", "vendor/run-update.sh"));
  assert.ok(!filenameMatches("x/evilvendor/run-update.sh", "vendor/run-update.sh"));
});

test("containsToken dispatches and ignores other kinds", () => {
  assert.strictEqual(containsToken("npm_package", "x", "x", "a"), null);
  assert.strictEqual(containsToken("domain", "foo.com", "foo.com", "a"), true);
  assert.ok(isTokenType("filename") && !isTokenType("github_dork"));
});
