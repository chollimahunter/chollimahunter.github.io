const test = require("node:test");
const assert = require("node:assert");
const { sourceKey } = require("./source-url.js");

const SAME = [
  ["https://spur.us/blog/astrill-vpn-and-dprk-remote-worker-fraud", "https://spur.us/blog/astrill-vpn-and-dprk-remote-worker-fraud/"],
  ["https://blog.google/a/b/", "https://blog.google/a/b/?fbclid=IwAR0x"],
  ["http://example.com/p", "https://example.com/p#top"],
  ["https://baesystemsai.blogspot.com/2017/02/x.html", "https://baesystemsai.blogspot.kr/2017/02/x.html"],
  ["https://d.hatena.ne.jp/Kango/20141228/1419787781", "https://piyolog.hatenadiary.jp/entry/20141228/1419787781"],
  ["https://www.elastic.co/kr/security-labs/x", "https://www.elastic.co/security-labs/threat-command/x"],
  ["https://blog.sekoia.io/slug/", "https://www.sekoia.com/blog/slug"],
  ["https://chollima-group.io/posts/a.html", "https://chollima-group.io/posts/a"],
];

test("spellings of one page share a key", () => {
  for (const [a, b] of SAME) assert.strictEqual(sourceKey(a), sourceKey(b), `${a} vs ${b}`);
});

test("different pages and meaningful query strings keep distinct keys", () => {
  assert.notStrictEqual(sourceKey("https://x.com/a/status/1"), sourceKey("https://x.com/a/status/2"));
  assert.notStrictEqual(sourceKey("https://e.com/?id=1"), sourceKey("https://e.com/?id=2"));
});
