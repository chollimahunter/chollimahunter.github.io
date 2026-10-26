#!/usr/bin/env node
/**
 * discover-sources.js
 * ==============================================================
 * Reads the RSS and Atom feeds (and, where a publisher has none, the sitemap)
 * of the publishers listed in scripts/data/feeds.json, keeps the recent items
 * that name a DPRK actor, campaign or malware family, drops every URL already
 * in scrape-sources.json (sources, declined sources, the discovery queue) or
 * the scraper's seen list, and appends what is left to the `discovered[]`
 * queue in src/_data/iocs/scrape-sources.json for a human to review.
 *
 * Nothing here publishes anything. The scraper reads `sources[]` only, so a
 * discovered article is not fetched, extracted or ingested until somebody
 * moves it into `sources[]` with a publisher and a campaign label -- or into
 * `not_scraped[]` with a reason, which stops it being rediscovered. See
 * docs/discover-sources.md.
 *
 * Usage:
 *   node scripts/discover-sources.js                    # last 14 days, write the queue
 *   node scripts/discover-sources.js --since 30 --dry-run
 *   node scripts/discover-sources.js --summary discovery-summary.md
 *   node scripts/discover-sources.js --probe            # find and verify each feed URL
 *   node scripts/discover-sources.js --probe --publisher Genians
 *
 * Other flags: --timeout <seconds> per request (default 20), --concurrency <n>
 * publishers at once (default 6), --include-undated to keep feed items that
 * carry no date.
 *
 * Prints "DISCOVERED=<n>" as its last line of stdout, n being the number of
 * new queue entries (0 on a dry run's write, though the candidates are listed).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { safeDecode } = require("./lib/ioc-normalize.js");
const {
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
  aggregatedItem,
  aggregatorReportLinks,
  aggregatorReport,
} = require("./lib/feeds.js");

/** Prints the header comment's opening paragraph and exits 0, for --help/-h. */
function printHelp() {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  if (!m) return;
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  const start = lines.findIndex((l) => /^=+$/.test(l.trim())) + 1;
  console.log(lines.slice(start).join("\n").trim());
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const FEEDS_PATH = path.join(__dirname, "data", "feeds.json");
const SOURCES_PATH = path.join(ROOT, "src", "_data", "iocs", "scrape-sources.json");
const SEEN_PATH = path.join(ROOT, "scripts", "data", "scraped-sources.txt");

/** At most this many recent sitemap pages are opened per publisher per run. */
const SITEMAP_PAGE_CAP = 40;
/** At most this many child sitemaps are read from one sitemap index. */
const SITEMAP_CHILD_CAP = 6;
/** Rows of the candidate table in the Markdown summary, so a PR body stays readable. */
const SUMMARY_ROWS = 60;

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function describeError(err) {
  const cause = err && err.cause;
  if (err && err.name === "TimeoutError") return "timed out";
  if (cause && (cause.code || cause.message)) return `${err.message}: ${cause.code || cause.message}`;
  return (err && err.message) || String(err);
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function loadSeen() {
  if (!fs.existsSync(SEEN_PATH)) return [];
  return fs
    .readFileSync(SEEN_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// ---------------------------------------------------------------------------
// Reading one publisher
// ---------------------------------------------------------------------------

async function readFeed(entry, opts) {
  const res = await fetchText(entry.feed, { timeoutMs: opts.timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const feed = parseFeed(res.text, res.url);
  if (!feed.kind) throw new Error(`not a feed (content-type "${res.contentType || "unknown"}")`);
  const items = feed.items.map((item) => ({ ...item, via: entry.feed }));
  if (!entry.aggregator) return items;
  const resolved = items.map(aggregatedItem).filter(Boolean);
  if (!entry.archive) return resolved;
  // The aggregator's feed holds only its last few items, fewer than a week's
  // worth, so its archive is read as well and each report page it lists that
  // the feed did not carry is opened, one at a time, for the original link.
  // The archive is paged newest first, so reading stops at the first page
  // whose reports all fall outside the window.
  const archiveUrl = entry.archive.replace("{year}", String(new Date().getUTCFullYear()));
  const inFeed = new Set(resolved.map((item) => item.aggregator_page));
  for (let n = 1; n <= (entry.archive_pages || 3); n++) {
    const page = await fetchText(n === 1 ? archiveUrl : `${archiveUrl}?page=${n}`, { timeoutMs: opts.timeoutMs });
    if (!page.ok) throw new Error(`archive page ${n} HTTP ${page.status}`);
    let recent = 0;
    for (const reportUrl of aggregatorReportLinks(page.text, page.url)) {
      if (inFeed.has(reportUrl)) { recent += 1; continue; }
      const res = await fetchText(reportUrl, { timeoutMs: opts.timeoutMs });
      const item = res.ok ? aggregatorReport(res.text, reportUrl) : null;
      if (!item) continue;
      resolved.push({ ...item, via: archiveUrl });
      if (!item.published || isWithinDays(item.published, opts.sinceDays, opts.now)) recent += 1;
    }
    if (!recent) break;
  }
  return resolved;
}

/**
 * A publisher with no feed, read through its sitemap: the entries modified in
 * the window, newest first, each opened for the title and description its
 * <head> declares, since a sitemap carries nothing to match a keyword on
 * except the URL.
 */
async function readSitemap(entry, opts) {
  const res = await fetchText(entry.sitemap, { timeoutMs: opts.timeoutMs, accept: "application/xml, text/xml;q=0.9, */*;q=0.5" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let parsed = parseSitemap(res.text);
  if (!parsed.kind) throw new Error("not a sitemap");
  let urls = [];
  if (parsed.kind === "sitemapindex") {
    const filter = entry.sitemap_child ? new RegExp(entry.sitemap_child, "i") : null;
    const children = parsed.entries
      .filter((child) => (filter ? filter.test(child.loc) : true))
      .filter((child) => !child.lastmod || isWithinDays(child.lastmod, opts.sinceDays + 1, opts.now))
      .sort((a, b) => String(b.lastmod || "").localeCompare(String(a.lastmod || "")))
      .slice(0, SITEMAP_CHILD_CAP);
    for (const child of children) {
      try {
        const childRes = await fetchText(child.loc, { timeoutMs: opts.timeoutMs });
        if (childRes.ok) urls.push(...parseSitemap(childRes.text).entries);
      } catch {
        // One unreadable child sitemap should not lose the others.
      }
    }
  } else {
    urls = parsed.entries;
  }
  const pathFilter = entry.path_filter ? new RegExp(entry.path_filter, "i") : null;
  const recent = urls
    .filter((u) => isWithinDays(u.lastmod, opts.sinceDays, opts.now))
    .filter((u) => (pathFilter ? pathFilter.test(u.loc) : true))
    .sort((a, b) => String(b.lastmod).localeCompare(String(a.lastmod)))
    .slice(0, SITEMAP_PAGE_CAP);
  const items = [];
  for (const u of recent) {
    // A candidate already known is not worth a request.
    if (opts.known.has(normalizeUrl(u.loc))) continue;
    try {
      const page = await fetchText(u.loc, { timeoutMs: opts.timeoutMs, accept: "text/html" });
      if (!page.ok) continue;
      const head = pageSummary(page.text);
      items.push({
        title: head.title,
        link: u.loc,
        // lastmod is when the page last changed, not when it was published;
        // the article's own metadata wins where it has one.
        published: head.published || u.lastmod,
        summary: head.summary,
        categories: head.keywords,
        via: entry.sitemap,
      });
    } catch {
      // Skipped quietly: the page will still be in the sitemap next week.
    }
  }
  return items;
}

async function readPublisher(entry, opts) {
  const result = { entry, items: [], error: null, skipped: false };
  try {
    if (entry.feed) result.items = await readFeed(entry, opts);
    else if (entry.sitemap) result.items = await readSitemap(entry, opts);
    else result.skipped = true;
  } catch (err) {
    result.error = describeError(err);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Probe: find and verify each publisher's feed
// ---------------------------------------------------------------------------

async function tryFeed(url, opts) {
  try {
    const res = await fetchText(url, { timeoutMs: opts.timeoutMs });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const feed = parseFeed(res.text, res.url);
    if (!feed.kind) return { ok: false, why: "not a feed" };
    if (!feed.items.length) return { ok: false, why: `${feed.kind} feed with no items` };
    return { ok: true, url, kind: feed.kind, count: feed.items.length, newest: feed.items.map((i) => i.published).filter(Boolean).sort().pop() || null };
  } catch (err) {
    return { ok: false, why: describeError(err) };
  }
}

async function trySitemap(origin, opts) {
  const candidates = [];
  try {
    const robots = await fetchText(`${origin}/robots.txt`, { timeoutMs: opts.timeoutMs, accept: "text/plain" });
    if (robots.ok) {
      for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.push(m[1]);
    }
  } catch {
    // Fall through to the conventional paths.
  }
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetchText(url, { timeoutMs: opts.timeoutMs, accept: "application/xml, text/xml;q=0.9, */*;q=0.5" });
      if (res.ok && parseSitemap(res.text).kind) return url;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

async function probePublisher(entry, opts) {
  const tried = [];
  if (entry.feed) {
    const r = await tryFeed(entry.feed, opts);
    if (r.ok) return { ...entry, verified: today(), status: `ok: ${r.kind}, ${r.count} items, newest ${r.newest ? r.newest.slice(0, 10) : "undated"}` };
    tried.push(`${entry.feed} (${r.why})`);
  }
  const site = entry.site;
  let siteError = null;
  let advertised = [];
  try {
    const res = await fetchText(site, { timeoutMs: opts.timeoutMs, accept: "text/html" });
    if (res.ok) advertised = findFeedLinks(res.text, res.url);
    else siteError = `HTTP ${res.status}`;
  } catch (err) {
    siteError = describeError(err);
  }
  const origin = new URL(site).origin;
  const sitePath = new URL(site).pathname.replace(/\/+$/, "");
  const guesses = [
    ...advertised,
    ...(sitePath ? KNOWN_FEED_PATHS.slice(0, 7).map((p) => origin + sitePath + p) : []),
    ...KNOWN_FEED_PATHS.map((p) => origin + p),
  ].filter((url) => url !== entry.feed);
  for (const url of [...new Set(guesses)]) {
    const r = await tryFeed(url, opts);
    if (r.ok) {
      return { ...entry, feed: url, verified: today(), status: `ok: ${r.kind}, ${r.count} items, newest ${r.newest ? r.newest.slice(0, 10) : "undated"}${advertised.includes(url) ? " (advertised)" : " (known path)"}` };
    }
    // Only the first few failures are worth recording.
    if (tried.length < 3) tried.push(`${url} (${r.why})`);
    // An unreachable host will not answer the next path either.
    if (/timed out|ENOTFOUND|ECONNREFUSED|certificate|CERT|SSL|TLS|ECONNRESET/i.test(r.why) && siteError) break;
  }
  const sitemap = entry.sitemap || (siteError ? null : await trySitemap(origin, opts));
  return {
    ...entry,
    feed: null,
    sitemap: sitemap || null,
    verified: sitemap ? today() : entry.verified || null,
    status: `no feed found${siteError ? `; site ${siteError}` : ""}; tried ${tried.join(", ") || "nothing"}${sitemap ? `; using sitemap` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function escapeCell(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

function markdownSummary({ sinceDays, results, candidates, written, dryRun }) {
  const read = results.filter((r) => !r.skipped && !r.error);
  const failed = results.filter((r) => r.error);
  const skipped = results.filter((r) => r.skipped);
  const itemsSeen = read.reduce((sum, r) => sum + r.items.length, 0);
  const lines = [];
  lines.push("## Source discovery");
  lines.push("");
  lines.push(
    `Read ${read.length} of ${results.length} publisher feeds over the last ${sinceDays} days: ` +
      `${itemsSeen} items seen, ${candidates.length} new DPRK-related candidate(s)` +
      (dryRun ? " (dry run, queue not written)." : `, ${written} added to \`discovered[]\` in \`src/_data/iocs/scrape-sources.json\`.`)
  );
  lines.push("");
  if (candidates.length) {
    lines.push(
      "Nothing below is scraped or published. Move an entry into `sources[]` (with `publisher` and `campaign`) to have the next run read it, or into `not_scraped[]` with a reason to stop it being rediscovered. See `docs/discover-sources.md`."
    );
    lines.push("");
    lines.push("| Published | Publisher | Title | Matched |");
    lines.push("|---|---|---|---|");
    for (const c of candidates.slice(0, SUMMARY_ROWS)) {
      lines.push(
        `| ${c.published || "undated"} | ${escapeCell(c.publisher)} | [${escapeCell(c.title || c.url)}](${c.url}) | ${escapeCell(c.matched_terms.join(", "))} |`
      );
    }
    if (candidates.length > SUMMARY_ROWS) {
      lines.push("");
      lines.push(`${candidates.length - SUMMARY_ROWS} more in the queue itself.`);
    }
    lines.push("");
  }
  if (failed.length) {
    lines.push(`<details><summary>${failed.length} feed(s) could not be read this run</summary>`);
    lines.push("");
    for (const r of failed) lines.push(`- ${escapeCell(r.entry.publisher)}: ${escapeCell(r.error)}`);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  if (skipped.length) {
    lines.push(`${skipped.length} publisher(s) have no feed or sitemap on record and were not read: ${skipped.map((r) => r.entry.publisher).join(", ")}.`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const probe = args.includes("--probe");
  const includeUndated = args.includes("--include-undated");
  const sinceDays = positiveNumber(flag(args, "--since", "14"), "--since");
  const timeoutMs = positiveNumber(flag(args, "--timeout", "20"), "--timeout") * 1000;
  const concurrency = Math.floor(positiveNumber(flag(args, "--concurrency", "6"), "--concurrency"));
  const summaryPath = flag(args, "--summary", null);
  const only = flag(args, "--publisher", null);

  const feedsDoc = JSON.parse(fs.readFileSync(FEEDS_PATH, "utf8"));
  const selected = feedsDoc.feeds.filter(
    (entry) => !only || entry.publisher.toLowerCase().includes(only.toLowerCase())
  );

  if (probe) {
    console.log(`Probing ${selected.length} publisher(s) for a feed...`);
    const probed = await pool(selected, concurrency, (entry) => probePublisher(entry, { timeoutMs }));
    let ok = 0;
    for (const entry of probed) {
      if (entry.feed && entry.status.startsWith("ok")) ok += 1;
      console.log(`  ${entry.feed ? "FEED   " : entry.sitemap ? "SITEMAP" : "NONE   "} ${entry.publisher}: ${entry.feed || entry.sitemap || "-"}\n          ${entry.status}`);
    }
    console.log(`\n${ok} of ${probed.length} feed(s) verified.`);
    if (!dryRun) {
      const fresh = JSON.parse(fs.readFileSync(FEEDS_PATH, "utf8"));
      const replaced = new Map(selected.map((entry, i) => [entry.publisher + "\u0000" + entry.site, probed[i]]));
      fresh.feeds = fresh.feeds.map((entry) => replaced.get(entry.publisher + "\u0000" + entry.site) || entry);
      writeFileAtomic(FEEDS_PATH, JSON.stringify(fresh, null, 2) + "\n");
      console.log(`Wrote ${path.relative(ROOT, FEEDS_PATH)}.`);
    }
    return;
  }

  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const known = knownUrlSet(config, loadSeen());
  const compiled = compileKeywords(feedsDoc.keywords, feedsDoc.case_sensitive_keywords);
  const now = new Date();

  const readable = selected.filter((entry) => entry.feed || entry.sitemap);
  console.log(`Reading ${readable.length} feed(s), items from the last ${sinceDays} day(s)...`);
  const results = await pool(selected, concurrency, (entry) =>
    readPublisher(entry, { timeoutMs, sinceDays, now, known })
  );

  const matched = [];
  let undated = 0;
  let inWindow = 0;
  for (const result of results) {
    const { entry } = result;
    if (result.skipped) continue;
    if (result.error) {
      console.log(`  FAILED  ${entry.publisher}: ${result.error}`);
      continue;
    }
    let kept = 0;
    for (const item of result.items) {
      if (!item.link) continue;
      if (!item.published) {
        undated += 1;
        if (!includeUndated) continue;
      } else if (!isWithinDays(item.published, sinceDays, now)) {
        continue;
      }
      inWindow += 1;
      // A sitemap item has only a URL slug to go on when the page's head is
      // bare, so the slug is read too, with its hyphens as spaces.
      let terms = matchItem(item, compiled);
      // An aggregator lists only DPRK reporting, so its items need no term to
      // qualify; one that matches none (a heist named only by its victim)
      // is kept and marked as coming from the aggregator.
      if (!terms.length && entry.aggregator) terms = [entry.publisher];
      if (!terms.length && item.via === entry.sitemap) {
        const slug = safeDecode(new URL(item.link).pathname).replace(/[-_/]+/g, " ");
        terms = matchKeywords(slug, compiled);
      }
      if (!terms.length) continue;
      kept += 1;
      matched.push({
        url: stripTracking(item.link),
        publisher: item.publisher || entry.publisher,
        title: item.title || null,
        published: item.published ? item.published.slice(0, 10) : null,
        feed: item.via,
        matched_terms: terms,
        discovered: today(),
      });
    }
    console.log(`  ok      ${entry.publisher}: ${result.items.length} item(s), ${kept} match(es)`);
  }

  matched.sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  const candidates = dedupeCandidates(matched, known);

  const itemsSeen = results.reduce((sum, r) => sum + r.items.length, 0);
  const feedsRead = results.filter((r) => !r.skipped && !r.error).length;
  console.log(
    `\nRead ${feedsRead} of ${readable.length} feed(s): ${itemsSeen} item(s) seen, ${inWindow} in the window` +
      `${undated && !includeUndated ? ` (${undated} undated item(s) ignored)` : ""}, ` +
      `${matched.length} matched a DPRK term, ${candidates.length} new after dedupe.`
  );
  for (const c of candidates) {
    console.log(`  + ${c.published || "undated"}  ${c.publisher}: ${c.title || c.url}\n      ${c.url}\n      [${c.matched_terms.join(", ")}]`);
  }

  let written = 0;
  if (!dryRun && candidates.length) {
    // Re-read just before writing, so an edit made while the feeds were being
    // fetched is not overwritten, and re-deduped against that fresh copy.
    const fresh = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
    const toAdd = dedupeCandidates(candidates, knownUrlSet(fresh, loadSeen()));
    fresh.discovered = [...(fresh.discovered || []), ...toAdd];
    writeFileAtomic(SOURCES_PATH, JSON.stringify(fresh, null, 2) + "\n");
    written = toAdd.length;
    console.log(`Added ${written} entr${written === 1 ? "y" : "ies"} to discovered[] in ${path.relative(ROOT, SOURCES_PATH)}.`);
  }

  if (summaryPath) {
    fs.writeFileSync(summaryPath, markdownSummary({ sinceDays, results, candidates, written, dryRun }) + "\n", "utf8");
  }
  console.log(`DISCOVERED=${written}`);
  // Whatever was found stays written; a failing exit code reports an outage.
  if (readable.length > 0 && feedsRead < readable.length / 2) {
    console.error(`Fewer than half of the feeds could be read (${feedsRead} of ${readable.length}).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Discovery failed:", err.message);
  console.log("DISCOVERED=0");
  process.exitCode = 1;
});
