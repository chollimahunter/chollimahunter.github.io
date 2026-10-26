/**
 * html-entities.test.js — entity decoding at extraction, and the Cloudflare
 * placeholder. Run with `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { decodeEntities, stripCfEmailPlaceholder } = require("./html-entities.js");
const { parseFeed } = require("./feeds.js");

test("decodeEntities decodes the forms stored titles and URLs carried, once", () => {
  for (const [label, input, expected] of [
    ["quoted title", "&quot;Million OK!!!!&quot; and the Naver Facade", '"Million OK!!!!" and the Naver Facade'],
    ["query string", "https://hauri.co.kr/v.html?intSeq=86&amp;page=1&amp;key=", "https://hauri.co.kr/v.html?intSeq=86&page=1&key="],
    ["hex apostrophe", "Kimsuky&#x27;s-Attacks", "Kimsuky's-Attacks"],
    ["decimal", "AT&#38;T", "AT&T"],
    ["one pass only", "&amp;quot;", "&quot;"],
    ["numeric then named is not chained", "&#38;quot;", "&quot;"],
    ["unknown name kept", "&bogus; stays", "&bogus; stays"],
    ["out-of-range code point kept", "&#x110000;", "&#x110000;"],
    ["already decoded", 'AT&T "quoted"', 'AT&T "quoted"'],
    ["null passes through", null, null],
  ]) {
    assert.equal(decodeEntities(input), expected, label);
  }
});

test("stripCfEmailPlaceholder removes the placeholder left beside a decoded address", () => {
  assert.equal(
    stripCfEmailPlaceholder("myronenkoyaroslav4@gmail.com[email protected] next"),
    "myronenkoyaroslav4@gmail.com next"
  );
  assert.equal(stripCfEmailPlaceholder("Contact [email protected] now"), "Contact  now");
  assert.equal(stripCfEmailPlaceholder("no placeholder"), "no placeholder");
});

test("the feed reader stores titles and links decoded", () => {
  const xml =
    '<?xml version="1.0"?><rss><channel><item><title>&quot;Hello?&quot; Kimsuky&#x27;s tactics</title>' +
    "<link>https://example.com/a?x=1&amp;y=2</link><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>";
  const [item] = parseFeed(xml).items;
  assert.equal(item.title, '"Hello?" Kimsuky\'s tactics');
  assert.equal(item.link, "https://example.com/a?x=1&y=2");
});
