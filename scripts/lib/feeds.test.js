/**
 * feeds.test.js — table-driven tests for scripts/lib/feeds.js
 * ==========================================================================
 * Cases exercise the feed, sitemap and URL helpers behind
 * scripts/discover-sources.js: parseFeed on RSS and Atom samples carrying
 * CDATA and entities, parseSitemap on both sitemap shapes, normalizeUrl and
 * stripTracking, the whole-word/case-sensitive/script-aware keyword matcher,
 * and dedupeCandidates against a known-URL set. Run with `node --test
 * scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFeed,
  parseSitemap,
  normalizeUrl,
  stripTracking,
  compileKeywords,
  matchKeywords,
  dedupeCandidates,
  knownUrlSet,
  aggregatedItem,
  aggregatorReportLinks,
  aggregatorReport,
} = require("./feeds.js");

// ---------------------------------------------------------------------------
// aggregatedItem — an aggregator item resolves to the article it summarises.
// ---------------------------------------------------------------------------
test("aggregatedItem takes the source URL and publisher from the summary", () => {
  const item = {
    title: "Bitget",
    link: "https://lazarus.day/reports/bitget-8PogA/",
    summary: "Attackers exploited a zero-day. | Source: https://rekt.news/bitget-rekt (Rekt) | Tags: Bitget",
  };
  const out = aggregatedItem(item);
  assert.equal(out.link, "https://rekt.news/bitget-rekt");
  assert.equal(out.publisher, "Rekt");
  assert.equal(out.aggregator_page, "https://lazarus.day/reports/bitget-8PogA/");
  assert.equal(aggregatedItem({ link: "https://lazarus.day/x/", summary: "No source here." }), null);
});

// ---------------------------------------------------------------------------
// parseFeed — RSS 2.0, CDATA-wrapped title/description, an entity in the
// title, a permalink guid used when <link> is absent.
// ---------------------------------------------------------------------------
const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Example Threat Blog</title>
  <link>https://example.com/</link>
  <item>
    <title><![CDATA[Lazarus &amp; Friends Target Devs]]></title>
    <link>https://example.com/posts/lazarus-friends</link>
    <pubDate>Wed, 24 Sep 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[<p>A report on &quot;BeaverTail&quot; malware.</p>]]></description>
  </item>
  <item>
    <title>No link, only a permalink guid</title>
    <guid isPermaLink="true">https://example.com/posts/guid-only</guid>
    <pubDate>Thu, 25 Sep 2026 08:30:00 GMT</pubDate>
    <description>Plain text description.</description>
  </item>
</channel>
</rss>`;

test("parseFeed reads an RSS 2.0 document", () => {
  const feed = parseFeed(RSS_SAMPLE, "https://example.com/feed/");
  assert.equal(feed.kind, "rss");
  assert.equal(feed.title, "Example Threat Blog");
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  // CDATA is unwrapped and the entity inside it is decoded.
  assert.equal(first.title, "Lazarus & Friends Target Devs");
  assert.equal(first.link, "https://example.com/posts/lazarus-friends");
  assert.equal(first.published, new Date("2026-09-24T12:00:00Z").toISOString());
  // The CDATA description carries escaped HTML, which is stripped and its
  // own entity decoded, leaving plain text.
  assert.equal(first.summary, 'A report on "BeaverTail" malware.');

  // No <link>, so the permalink guid is used instead.
  assert.equal(second.link, "https://example.com/posts/guid-only");
  assert.equal(second.published, new Date("2026-09-25T08:30:00Z").toISOString());
});

// ---------------------------------------------------------------------------
// parseFeed — Atom, a namespaced <entry>, rel="alternate" chosen over
// rel="self", and an entity in a CDATA-free title.
// ---------------------------------------------------------------------------
const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Kimsuky &amp; the Fake Recruiter</title>
    <link rel="self" href="https://example.com/feed/entry-1"/>
    <link rel="alternate" href="https://example.com/entry-1"/>
    <updated>2026-09-20T00:00:00Z</updated>
    <summary><![CDATA[Covers <b>Kimsuky</b> &amp; friends' tradecraft.]]></summary>
  </entry>
</feed>`;

test("parseFeed reads an Atom document, preferring rel=alternate", () => {
  const feed = parseFeed(ATOM_SAMPLE, "https://example.com/feed/");
  assert.equal(feed.kind, "atom");
  assert.equal(feed.items.length, 1);

  const [entry] = feed.items;
  assert.equal(entry.title, "Kimsuky & the Fake Recruiter");
  assert.equal(entry.link, "https://example.com/entry-1");
  assert.equal(entry.published, new Date("2026-09-20T00:00:00Z").toISOString());
  // The CDATA carries real HTML: the <b> tag is flattened to a space and
  // the &amp; entity beside it is decoded.
  assert.equal(entry.summary, "Covers Kimsuky & friends' tradecraft.");
});

test("parseFeed returns kind null for a document that is neither", () => {
  const feed = parseFeed("<html><body>Not a feed</body></html>");
  assert.equal(feed.kind, null);
  assert.deepEqual(feed.items, []);
});

// ---------------------------------------------------------------------------
// parseSitemap — a urlset and a sitemap index.
// ---------------------------------------------------------------------------
const URLSET_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/posts/one</loc>
    <lastmod>2026-09-22</lastmod>
  </url>
  <url>
    <loc>https://example.com/posts/two</loc>
  </url>
</urlset>`;

test("parseSitemap reads a urlset", () => {
  const parsed = parseSitemap(URLSET_SAMPLE);
  assert.equal(parsed.kind, "urlset");
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].loc, "https://example.com/posts/one");
  assert.equal(parsed.entries[0].lastmod, new Date("2026-09-22").toISOString());
  // No <lastmod>, so it is null rather than a made-up date.
  assert.equal(parsed.entries[1].lastmod, null);
});

const SITEMAP_INDEX_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-posts-1.xml</loc>
    <lastmod>2026-09-24</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-posts-2.xml</loc>
    <lastmod>2026-08-01</lastmod>
  </sitemap>
</sitemapindex>`;

test("parseSitemap reads a sitemap index", () => {
  const parsed = parseSitemap(SITEMAP_INDEX_SAMPLE);
  assert.equal(parsed.kind, "sitemapindex");
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].loc, "https://example.com/sitemap-posts-1.xml");
  assert.equal(parsed.entries[1].lastmod, new Date("2026-08-01").toISOString());
});

test("parseSitemap returns kind null for neither shape", () => {
  const parsed = parseSitemap("<rss><channel></channel></rss>");
  assert.equal(parsed.kind, null);
  assert.deepEqual(parsed.entries, []);
});

// ---------------------------------------------------------------------------
// normalizeUrl — www stripping, trailing slash, index.html, tracking-param
// removal (utm_* and fbclid), param sorting, non-http rejected.
// ---------------------------------------------------------------------------
function runTable(name, fn, cases) {
  test(name, () => {
    for (const [label, input, expected] of cases) {
      assert.deepEqual(fn(input), expected, `${name}(${JSON.stringify(input)}) [${label}]`);
    }
  });
}

runTable("normalizeUrl", normalizeUrl, [
  ["www. is stripped and the host lowercased", "https://WWW.Example.com/Path", "https://example.com/Path"],
  ["a trailing slash on a non-root path is dropped", "https://example.com/path/", "https://example.com/path"],
  ["the root path keeps no trailing slash in the output", "https://example.com/", "https://example.com"],
  ["index.html collapses to the directory, and the resulting trailing slash is then trimmed", "https://example.com/blog/index.html", "https://example.com/blog"],
  ["utm_source and fbclid are removed", "https://example.com/post?utm_source=x&fbclid=123", "https://example.com/post"],
  [
    "a meaningful param survives while a tracking one beside it is dropped, and params sort",
    "https://example.com/post?utm_medium=feed&id=5&a=1",
    "https://example.com/post?a=1&id=5",
  ],
  ["http is accepted alongside https, but the output is always https", "http://example.com/path", "https://example.com/path"],
  ["a non-http(s) scheme is rejected", "ftp://example.com/file", null],
  ["not a URL at all is rejected", "not a url", null],
]);

// ---------------------------------------------------------------------------
// stripTracking — drops utm_medium=feed, keeps a meaningful param, returns
// the input unchanged when it does not parse as a URL.
// ---------------------------------------------------------------------------
test("stripTracking drops utm_medium=feed but keeps a meaningful param", () => {
  assert.equal(
    stripTracking("https://example.com/post?utm_medium=feed&id=5"),
    "https://example.com/post?id=5"
  );
});

test("stripTracking returns the input unchanged when it is not a URL", () => {
  assert.equal(stripTracking("not a url"), "not a url");
});

// ---------------------------------------------------------------------------
// compileKeywords / matchKeywords — whole-word matching, a case-sensitive
// term, and a Korean term matching as a substring.
// ---------------------------------------------------------------------------
test("matchKeywords is whole-word: Konni does not match inside Konnichiwa", () => {
  const compiled = compileKeywords(["Konni"]);
  assert.deepEqual(matchKeywords("Say Konnichiwa to everyone", compiled), []);
  assert.deepEqual(matchKeywords("Konni malware targeted the victim", compiled), ["Konni"]);
});

test("a caseSensitive term does not match a different-case spelling", () => {
  const compiled = compileKeywords([], ["IT worker"]);
  assert.deepEqual(matchKeywords("This tool helps an it worker do their job", compiled), []);
  assert.deepEqual(matchKeywords("The report describes an IT worker scheme", compiled), ["IT worker"]);
});

test("a Korean term matches as a plain substring, with no word boundary", () => {
  const compiled = compileKeywords(["북한"]);
  assert.deepEqual(matchKeywords("북한 IT 인력에 대한 보고서", compiled), ["북한"]);
});

// ---------------------------------------------------------------------------
// dedupeCandidates — drops URLs already in the known set, and duplicates
// within the batch differing only by tracking params or www.
// ---------------------------------------------------------------------------
test("dedupeCandidates drops a candidate already in the known set", () => {
  const known = new Set([normalizeUrl("https://example.com/already-known")]);
  const candidates = [
    { url: "https://example.com/already-known" },
    { url: "https://example.com/new-one" },
  ];
  const out = dedupeCandidates(candidates, known);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://example.com/new-one");
});

test("dedupeCandidates drops within-batch duplicates that differ only by www or tracking params", () => {
  const candidates = [
    { url: "https://www.example.com/post?utm_source=feed" },
    { url: "https://example.com/post" },
    { url: "https://example.com/post?utm_campaign=other" },
  ];
  const out = dedupeCandidates(candidates, new Set());
  // Only the first occurrence survives; the other two normalize the same way.
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://www.example.com/post?utm_source=feed");
});

// ---------------------------------------------------------------------------
// aggregatorReportLinks / aggregatorReport — lazarus.day's archive and report
// pages, as served on 2026-10-01.
// ---------------------------------------------------------------------------
test("aggregatorReportLinks lists report pages only, once each", () => {
  const html = '<a href="/reports/2026/">2026</a><a href="/reports/bitget-8PogA/">x</a>' +
    '<a href="/reports/bitget-8PogA/">x</a><a href="/reports/feed/">feed</a>';
  assert.deepEqual(aggregatorReportLinks(html, "https://lazarus.day/reports/2026/"), ["https://lazarus.day/reports/bitget-8PogA/"]);
});

test("aggregatorReport reads the title, date, publisher and original link", () => {
  const html = `<main><section><hgroup>
    <h2>SEAL weekly stats: Sept. 22-29, 2026</h2>
    <p>2026-09-29 <span>•</span> <a href="/authors/securityalliance/">Security Alliance</a>
    <a href="/reports/seal-7VlGZ/stix/" title="Export STIX 2.1"><i></i></a></p>
    <p><a href="https://radar.securityalliance.org/seal-weekly-stats" class="secondary" target="_blank">https://radar.securityalliance.org/seal-weekly-stats</a></p>
  </hgroup></section></main>`;
  const item = aggregatorReport(html, "https://lazarus.day/reports/seal-7VlGZ/");
  assert.equal(item.title, "SEAL weekly stats: Sept. 22-29, 2026");
  assert.equal(item.link, "https://radar.securityalliance.org/seal-weekly-stats");
  assert.equal(item.published, "2026-09-29T00:00:00Z");
  assert.equal(item.publisher, "Security Alliance");
  assert.equal(aggregatorReport("<main>no hgroup</main>", "x"), null);
});

test("knownUrlSet counts the original address of a source read through Wayback", () => {
  const known = knownUrlSet({
    sources: [{
      url: "https://web.archive.org/web/20260928143817/https://socradar.io/blog/konni-lnk/",
      original_url: "https://socradar.io/blog/konni-lnk/",
    }],
  });
  const out = dedupeCandidates([{ url: "https://socradar.io/blog/konni-lnk/" }], known);
  assert.deepEqual(out, []);
});
