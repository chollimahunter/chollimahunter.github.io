const test = require("node:test");
const assert = require("node:assert");
const { namesOf, isShared, readSeed, leads } = require("./ct-pivot.js");

// A two-label registrable domain is enough for these fixtures.
const reg = (h) => h.split(".").slice(-2).join(".");

test("namesOf drops wildcards and duplicates", () => {
  assert.deepStrictEqual(namesOf({ names: ["*.evil.com", "evil.com", "API.evil.com."] }), ["evil.com", "api.evil.com"]);
});

test("a platform's shared certificate is set aside", () => {
  assert.ok(isShared(["sni123.cloudflaressl.com", "evil.com"], reg));
  assert.ok(isShared(["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com"], reg));
  assert.ok(!isShared(["evil.com", "www.evil.com", "other-evil.net"], reg));
});

test("readSeed separates subdomains, siblings and keys", () => {
  const certs = [
    { names: ["evil.com", "api.evil.com", "sister.net"], not_before: "2026-01-02T00:00:00Z", pubkey: "k1" },
    { names: ["sni9.cloudflaressl.com", "evil.com", "unrelated.org"], pubkey: "k2" },
  ];
  const r = readSeed("evil.com", certs, reg);
  assert.deepStrictEqual(r.subdomains, [{ host: "api.evil.com", first: "2026-01-02", last: "2026-01-02" }]);
  assert.deepStrictEqual(r.siblings, [{ domain: "sister.net", names: ["sister.net"], first: "2026-01-02", last: "2026-01-02" }]);
  assert.deepStrictEqual(r.keys, ["k1"]);
  assert.strictEqual(r.shared, 1);
});

test("leads skip what is indexed and tie seeds that share a key", () => {
  const seeds = {
    "evil.com": { siblings: [{ domain: "sister.net", names: ["sister.net"] }, { domain: "known.org", names: ["known.org"] }], keys: ["k1"], subdomains: [{ host: "api.evil.com", first: "x" }] },
    "evil2.com": { siblings: [{ domain: "sister.net", names: ["www.sister.net"] }], keys: ["k1"], subdomains: [] },
    "dead.com": { error: 500 },
  };
  const l = leads(seeds, new Set(["known.org"]));
  assert.deepStrictEqual(l.siblings.map((g) => [g.domain, g.seeds.length]), [["sister.net", 2]]);
  assert.deepStrictEqual(l.sharedKeys, [{ key: "k1", seeds: ["evil.com", "evil2.com"] }]);
  assert.deepStrictEqual(l.subdomains.map((s) => s.host), ["api.evil.com"]);
});

test("a certificate from before the seed's registration belongs to an earlier owner", () => {
  const seeds = { "evil.com": { siblings: [{ domain: "old.net", names: ["old.net"], first: "2015-01-01", last: "2016-01-01" }, { domain: "new.net", names: ["new.net"], first: "2015-01-01", last: "2026-03-01" }], keys: [], subdomains: [{ host: "mail.evil.com", first: "2014-01-01", last: "2014-06-01" }] } };
  const l = leads(seeds, new Set(), { "evil.com": "2026-01-01" });
  assert.deepStrictEqual(l.siblings.map((g) => g.domain), ["new.net"]);
  assert.deepStrictEqual(l.subdomains, []);
});
