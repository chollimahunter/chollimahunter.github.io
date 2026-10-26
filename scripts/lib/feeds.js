/**
 * feeds.js — the feed, sitemap and URL helpers behind scripts/discover-sources.js
 * ==========================================================================
 * Node has no XML parser built in, and this repository takes no dependencies
 * beyond Eleventy, so feeds are read with tolerant regular expressions rather
 * than a DOM. That is enough for the three shapes publishers actually serve --
 * RSS 2.0, RSS 1.0 (RDF) and Atom -- and for sitemaps, provided two things are
 * handled first: CDATA sections, which may contain anything including a
 * literal "</item>", and namespace prefixes, which some feeds put on every tag
 * (<atom:entry>, <rss:item>) and most put on a few (<dc:date>,
 * <content:encoded>). Every function here is pure except fetchText().
 */
"use strict";

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeXmlEntities(input) {
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => safeCodePoint(Number(dec), m))
    .replace(/&([a-z]+);/gi, (m, name) => XML_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Comments removed and every CDATA section replaced by its content, escaped,
 * so the tag scanner below never sees markup that lives inside a CDATA block.
 * After this, every text node in the document is entity-encoded text and
 * decodeXmlEntities() recovers it whatever form the publisher used.
 */
function preprocessXml(xml) {
  return String(xml)
    .replace(/^﻿/, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => escapeXml(inner))
    .replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Every <prefix:name ...>...</prefix:name> block, prefix optional. A
 * self-closing <atom:link .../> is not an opening tag, or the lazy match would
 * run on to the next item's </link>.
 */
function blocks(xml, name) {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`,
    "gi"
  );
  return [...xml.matchAll(pattern)].map((m) => ({ attrs: attrsOf(m[0]), inner: m[1] }));
}

/** The attributes of the opening tag at the start of `tag`. */
function attrsOf(tag) {
  const open = tag.match(/^<[^>]*>/);
  const attrs = {};
  if (!open) return attrs;
  for (const m of open[0].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

/** Self-closing or empty elements, e.g. <link href="..."/> or <category term="x"/>. */
function emptyElements(xml, name) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?/?>`, "gi");
  return [...xml.matchAll(pattern)].map((m) => attrsOf(m[0]));
}

/** Text content with any markup it carries (an escaped HTML summary) flattened. */
function plainText(inner) {
  const decoded = decodeXmlEntities(inner);
  // An HTML summary arrives entity-encoded, so the first decode yields markup.
  return decodeXmlEntities(decoded.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function firstText(xml, names) {
  for (const name of names) {
    const found = blocks(xml, name);
    for (const block of found) {
      const text = plainText(block.inner);
      if (text) return text;
    }
  }
  return null;
}

function toIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value).trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** The link of an RSS item: <link>text</link>, else a permalink <guid>. */
function rssLink(inner) {
  for (const block of blocks(inner, "link")) {
    const text = plainText(block.inner);
    if (/^https?:\/\//i.test(text)) return text;
  }
  for (const attrs of emptyElements(inner, "link")) {
    if (attrs.href && (!attrs.rel || attrs.rel === "alternate")) return attrs.href;
  }
  for (const block of blocks(inner, "guid")) {
    const text = plainText(block.inner);
    if (block.attrs.ispermalink !== "false" && /^https?:\/\//i.test(text)) return text;
  }
  return null;
}

/** The link of an Atom entry: rel="alternate" (or no rel) wins over the rest. */
function atomLink(inner) {
  const links = emptyElements(inner, "link").filter((attrs) => attrs.href);
  const alternate =
    links.find((attrs) => !attrs.rel || attrs.rel === "alternate") ||
    links.find((attrs) => attrs.rel !== "self" && attrs.rel !== "edit" && attrs.rel !== "replies");
  if (alternate) return alternate.href;
  const id = firstText(inner, ["id"]);
  return id && /^https?:\/\//i.test(id) ? id : null;
}

function categoriesOf(inner) {
  const out = [];
  for (const block of blocks(inner, "category")) {
    const text = plainText(block.inner) || block.attrs.term || block.attrs.label;
    if (text) out.push(text);
  }
  for (const attrs of emptyElements(inner, "category")) {
    if (attrs.term) out.push(attrs.term);
    else if (attrs.label) out.push(attrs.label);
  }
  for (const block of blocks(inner, "subject")) {
    const text = plainText(block.inner);
    if (text) out.push(text);
  }
  return [...new Set(out)];
}

function resolveUrl(link, base) {
  if (!link) return null;
  try {
    return new URL(link.trim(), base || undefined).toString();
  } catch {
    return null;
  }
}

/**
 * Parses an RSS 2.0, RSS 1.0 or Atom document.
 *
 * Returns { kind, title, items } where kind is "rss", "rdf", "atom" or null
 * (not a feed), and each item is { title, link, published, summary,
 * categories }. `published` is an ISO timestamp or null. Relative links are
 * resolved against `baseUrl` when one is given.
 */
function parseFeed(xml, baseUrl) {
  const doc = preprocessXml(xml);
  let kind = null;
  if (/<(?:[\w.-]+:)?rss[\s>]/i.test(doc)) kind = "rss";
  else if (/<(?:[\w.-]+:)?RDF[\s>]/.test(doc)) kind = "rdf";
  else if (/<(?:[\w.-]+:)?feed[\s>]/i.test(doc) && /<(?:[\w.-]+:)?entry[\s>]/i.test(doc)) kind = "atom";
  else if (/<(?:[\w.-]+:)?feed[\s>][^>]*2005\/Atom/i.test(doc)) kind = "atom";
  if (!kind) return { kind: null, title: null, items: [] };

  const itemBlocks = kind === "atom" ? blocks(doc, "entry") : blocks(doc, "item");
  const head = doc.split(/<(?:[\w.-]+:)?(?:item|entry)[\s>]/i)[0];
  const title = firstText(head, ["title"]);

  const items = itemBlocks.map(({ inner }) => {
    const link = kind === "atom" ? atomLink(inner) : rssLink(inner);
    const published = toIsoDate(
      firstText(inner, kind === "atom" ? ["published", "updated", "issued", "date"] : ["pubDate", "date", "published", "updated", "issued"])
    );
    const summary = firstText(inner, ["description", "summary", "encoded", "content"]) || "";
    return {
      title: firstText(inner, ["title"]) || "",
      link: resolveUrl(link, baseUrl),
      published,
      summary: summary.length > 2000 ? summary.slice(0, 2000) : summary,
      categories: categoriesOf(inner),
    };
  });
  return { kind, title, items };
}

/**
 * Parses a sitemap or sitemap index. Returns { kind: "urlset" | "sitemapindex"
 * | null, entries: [{ loc, lastmod }] } with lastmod as an ISO timestamp.
 */
function parseSitemap(xml) {
  const doc = preprocessXml(xml);
  let kind = null;
  if (/<(?:[\w.-]+:)?sitemapindex[\s>]/i.test(doc)) kind = "sitemapindex";
  else if (/<(?:[\w.-]+:)?urlset[\s>]/i.test(doc)) kind = "urlset";
  if (!kind) return { kind: null, entries: [] };
  const entries = blocks(doc, kind === "sitemapindex" ? "sitemap" : "url")
    .map(({ inner }) => ({
      loc: firstText(inner, ["loc"]),
      lastmod: toIsoDate(firstText(inner, ["lastmod"])),
    }))
    .filter((entry) => entry.loc);
  return { kind, entries };
}

const FEED_TYPES = /application\/(?:rss|atom|rdf|feed)\+xml|application\/xml|text\/xml/i;

/**
 * The feed URLs an HTML page advertises with <link rel="alternate">, in page
 * order, resolved against the page URL. Comment feeds are left out: a
 * WordPress site advertises one next to the post feed, and it carries
 * readers' comments rather than articles.
 */
function findFeedLinks(html, pageUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attrsOf(m[0]);
    const rel = (attrs.rel || "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate")) continue;
    if (!FEED_TYPES.test(attrs.type || "")) continue;
    if (/comments?/i.test(attrs.title || "") || /\/comments\/feed/i.test(attrs.href || "")) continue;
    const resolved = resolveUrl(attrs.href, pageUrl);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/** The feed paths tried, in order, when a page advertises none. */
const KNOWN_FEED_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/blog/feed", "/blog/rss.xml", "/blog/feed.xml", "/blog/atom.xml"];

// ---------------------------------------------------------------------------
// URL normalisation and dedupe
// ---------------------------------------------------------------------------

/** Query parameters that say how a reader arrived, never which page it is. */
const TRACKING_PARAMS = /^(?:utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|__hstc|__hssc|__hsfp|hsctatracking|mkt_tok|ref|ref_src|ref_url|source|src|cmpid|campaign|trk|trkcampaign|sc_channel|sc_campaign|share|spm|igshid|yclid|wt\.mc_id|at_medium|at_campaign|rss|feed)$/i;

/**
 * One spelling per page, so a feed's link and a hand-added source compare
 * equal: https, no www., lower-case host, no fragment, no tracking
 * parameters, the rest sorted, no default port, no trailing slash (the root
 * path aside), and no "index.html". Returns null for anything that is not an
 * http(s) URL. Used only to compare -- a stored source URL is never rewritten.
 */
function normalizeUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  let pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/index\.html?$/i, "/");
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  return `https://${host}${port}${pathname === "/" ? "" : pathname}${query}`;
}

/**
 * The link as published, minus tracking parameters. The queue keeps the
 * publisher's own host and path so the entry can be moved into sources[] as it
 * stands; only the feed's ?utm_medium=feed and the like are dropped.
 */
function stripTracking(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return input;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * The URLs already decided on, normalised: every source, every declined or
 * withdrawn source, everything waiting in the discovery queue, and anything
 * else passed in (the scraper's seen list).
 */
function knownUrlSet(config, extra = []) {
  const set = new Set();
  const add = (url) => {
    const normal = normalizeUrl(url);
    if (normal) set.add(normal);
  };
  // A source read through a Wayback snapshot keeps the article's own address
  // in original_url, which is the address a feed announces it under.
  for (const entry of config.sources || []) {
    add(entry.url);
    if (entry.original_url) add(entry.original_url);
  }
  for (const entry of config.not_scraped || []) {
    add(entry.url);
    if (entry.original_url) add(entry.original_url);
  }
  for (const entry of config.discovered || []) add(entry.url);
  for (const url of extra) add(url);
  return set;
}

/**
 * Candidates not already known, and not repeated within the batch. Keeps the
 * first occurrence, so a caller that sorts newest-first keeps the newest.
 */
function dedupeCandidates(candidates, known) {
  const seen = new Set(known);
  const out = [];
  for (const candidate of candidates) {
    const normal = normalizeUrl(candidate.url);
    if (!normal || seen.has(normal)) continue;
    seen.add(normal);
    out.push(candidate);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyword filter
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles the keyword list into one matcher. Terms are case-insensitive and
 * whole-word ("Konni" does not match "Konnichiwa"), except that a term in
 * `caseSensitive` must match its capitals exactly -- "IT worker" is the
 * reason: case-insensitively it matches "it worker" in any sentence about
 * what a tool does for a worker. A term written in a script without word
 * spacing (Korean, Japanese, Chinese) matches as a plain substring, since a
 * word boundary means nothing there.
 */
function compileKeywords(terms = [], caseSensitive = []) {
  const compiled = [];
  const push = (term, sensitive) => {
    const clean = String(term).trim();
    if (!clean) return;
    const spaced = /^[\p{Script=Latin}\p{N}\s.#'&+-]+$/u.test(clean);
    const body = escapeRegExp(clean).replace(/\s+/g, "[\\s\\u00a0-]+");
    const source = spaced ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body;
    compiled.push({ term: clean, pattern: new RegExp(source, sensitive ? "u" : "iu") });
  };
  for (const term of terms) push(term, false);
  for (const term of caseSensitive) push(term, true);
  return compiled;
}

/** The terms that occur in `text`, in list order, each once. */
function matchKeywords(text, compiled) {
  const haystack = String(text || "");
  const found = [];
  for (const { term, pattern } of compiled) {
    if (pattern.test(haystack) && !found.includes(term)) found.push(term);
  }
  return found;
}

/** The terms an item matches, read from its title, summary and categories. */
function matchItem(item, compiled) {
  return matchKeywords(
    [item.title, item.summary, ...(item.categories || [])].join("\n"),
    compiled
  );
}

/** True when an ISO date falls within the last `days` days of `now`. */
function isWithinDays(iso, days, now = new Date()) {
  if (!iso) return false;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  // A day of slack for a publisher that dates its posts in the future by a
  // time-zone offset.
  return time >= now.getTime() - days * 86400000 && time <= now.getTime() + 86400000;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const USER_AGENT =
  "ChollimaHunterDiscovery/1.0 (+https://chollimahunter.github.io/; public DPRK threat-intel index)";

/**
 * GET a URL as text with a timeout and a body cap. Resolves to { ok, status,
 * url (after redirects), contentType, text } or rejects on a network error.
 */
async function fetchText(url, { timeoutMs = 20000, maxBytes = 8_000_000, accept } = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        accept ||
        "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`body exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    url: response.url || url,
    contentType: (response.headers.get("content-type") || "").toLowerCase(),
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

/** The title and description a page declares in its <head>, for a sitemap entry. */
function pageSummary(html) {
  const head = String(html).split(/<body[\s>]/i)[0];
  const meta = (name) => {
    for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = attrsOf(m[0]);
      if ((attrs.property || attrs.name || "").toLowerCase() === name && attrs.content) return attrs.content;
    }
    return null;
  };
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: meta("og:title") || (titleTag ? plainText(titleTag[1]) : "") || "",
    summary: meta("og:description") || meta("description") || "",
    keywords: (meta("keywords") || meta("article:tag") || "").split(",").map((s) => s.trim()).filter(Boolean),
    published: toIsoDate(meta("article:published_time")),
  };
}

/**
 * The original article an aggregator's feed item points at. lazarus.day ends
 * each item's description with "| Source: <url> (<publisher>)"; the queue
 * takes that URL and publisher, so nothing is ever cited to the aggregator.
 * Returns null for an item that names no source.
 */
function aggregatedItem(item) {
  const m = String(item.summary || "").match(/\|\s*Source:\s*(https?:\/\/\S+)\s*\(([^)]+)\)/);
  if (!m) return null;
  return { ...item, link: m[1], publisher: m[2].trim(), aggregator_page: item.link };
}

/**
 * The report pages an aggregator's archive lists, as absolute URLs. On
 * lazarus.day a report path ends in a five-character id: /reports/<slug>-AbC12/.
 */
function aggregatorReportLinks(html, base) {
  const out = new Set();
  for (const m of String(html).matchAll(/href="(\/reports\/[a-z0-9-]+-[A-Za-z0-9]{5}\/)"/g)) {
    out.add(new URL(m[1], base).href);
  }
  return [...out];
}

/**
 * One aggregator report page read as a feed item pointing at the original:
 * the <hgroup> carries the title, the date, the author link and, in its own
 * paragraph, the link to the publisher's article. Null when there is none.
 */
function aggregatorReport(html, pageUrl) {
  const head = (String(html).match(/<hgroup>([\s\S]*?)<\/hgroup>/) || [])[1];
  if (!head) return null;
  const link = (head.match(/<a href="(https?:\/\/[^"]+)"[^>]*target="_blank"/) || [])[1];
  if (!link) return null;
  const text = (re) => ((head.match(re) || [])[1] || "").replace(/<[^>]+>/g, "").trim();
  const date = (head.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1] || null;
  return {
    title: decodeXmlEntities(text(/<h2>([\s\S]*?)<\/h2>/)),
    link,
    published: date ? `${date}T00:00:00Z` : null,
    summary: "",
    categories: [],
    publisher: decodeXmlEntities(text(/<a href="\/authors\/[^"]*">([\s\S]*?)<\/a>/)) || null,
    aggregator_page: pageUrl,
  };
}

module.exports = {
  aggregatedItem,
  aggregatorReportLinks,
  aggregatorReport,
  decodeXmlEntities,
  preprocessXml,
  parseFeed,
  parseSitemap,
  findFeedLinks,
  KNOWN_FEED_PATHS,
  normalizeUrl,
  stripTracking,
  knownUrlSet,
  dedupeCandidates,
  compileKeywords,
  matchKeywords,
  matchItem,
  isWithinDays,
  fetchText,
  pageSummary,
  USER_AGENT,
};
