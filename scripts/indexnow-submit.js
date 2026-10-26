#!/usr/bin/env node
/**
 * scripts/indexnow-submit.js — tell the IndexNow search engines which pages
 * changed.
 *
 * IndexNow is one endpoint shared by Bing, Yandex, Naver, Seznam and Yep: a
 * POST naming the URLs that changed, and each of them fetches those pages
 * within minutes rather than whenever its crawler next comes round. Google
 * does not take part; it reads the sitemap. The site proves it owns the host
 * by serving the key at /<key>.txt (src/indexnow-key.njk), so the key is
 * public by design and lives in src/_data/site.json.
 *
 * Three modes, because the deploy workflow builds in one job and publishes
 * in another:
 *
 *   --plan <file>     compare the sitemaps in _site with the ones the live
 *                     site serves now, and write the URLs that are new, carry
 *                     a different lastmod, or are live but no longer in the
 *                     new sitemaps (IndexNow accepts removed URLs, which now
 *                     answer 404 or 410) to <file>. Runs in the build job,
 *                     before the old sitemaps are replaced. If the live root
 *                     sitemap or any child cannot be fetched, after one
 *                     retry, the plan is empty: with no baseline every URL
 *                     would look changed, so it submits nothing and exits 0.
 *   --submit <file>   POST the URLs in <file>. Runs in the deploy job after
 *                     the pages are live, so an engine that fetches at once
 *                     sees the new content.
 *   --all             submit every URL in the _site sitemaps. For a first
 *                     submission, or after the key changes. Run it locally
 *                     after a build.
 *
 * Every fetch has a 30-second timeout and is retried once after a short
 * backoff on a network error, a 5xx or a 429.
 *
 * It never fails the deploy: an engine that is down or a key not yet served
 * is reported and left for the next deploy, which resubmits whatever is
 * still different from what was live.
 */
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");

/** Prints the header comment's opening paragraph and exits 0, for --help/-h. */
function printHelp() {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  if (!m) return;
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  let bannerAt = -1;
  for (let j = 0; j < Math.min(lines.length, 6); j++) {
    if (/^=+$/.test(lines[j].trim())) { bannerAt = j; break; }
  }
  let i = bannerAt === -1 ? 0 : bannerAt + 1;
  while (lines[i] !== undefined && !lines[i].trim()) i++;
  const para = [];
  while (lines[i] !== undefined && lines[i].trim()) { para.push(lines[i]); i++; }
  console.log(para.join(" ").replace(/\s+/g, " ").trim());
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..");
const SITE_DIR = path.join(ROOT, "_site");
const site = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "_data", "site.json"), "utf8"));
const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH = 10000;
const TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 2000;

const args = process.argv.slice(2);
const mode = args[0];
const file = args[1];

function usage() {
  console.error("usage: node scripts/indexnow-submit.js --plan <file> | --submit <file> | --all");
  process.exit(2);
}

/** Every <loc> in a urlset, with its lastmod. */
function parseUrlset(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g)) {
    out.set(m[1].trim(), m[2] || "");
  }
  return out;
}

/** The child sitemaps of an index, or null when the file is a urlset. */
function parseIndex(xml) {
  if (!/<sitemapindex/.test(xml)) return null;
  return [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/** fetch with a timeout and one retry, after a short backoff, on a network error, a 5xx or a 429. */
async function fetchRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** url -> lastmod for every page a sitemap tree lists, given a reader for one file. A reader throws when a file is unavailable. */
async function collect(readSitemap) {
  const rootXml = await readSitemap("/sitemap.xml");
  if (rootXml == null) return new Map();
  const children = parseIndex(rootXml);
  if (!children) return parseUrlset(rootXml);
  const all = new Map();
  for (const loc of children) {
    const xml = await readSitemap(new URL(loc).pathname);
    if (xml == null) continue;
    for (const [url, lastmod] of parseUrlset(xml)) all.set(url, lastmod);
  }
  return all;
}

function readBuilt(pathname) {
  const p = path.join(SITE_DIR, pathname.replace(/^\//, ""));
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

async function readLive(pathname) {
  let res;
  try {
    res = await fetchRetry(site.url + pathname, { headers: { "user-agent": "chollimahunter-indexnow/1.0" } });
  } catch (err) {
    throw new Error(`could not fetch live ${pathname}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`live ${pathname} returned ${res.status}`);
  return await res.text();
}

/** The URLs to submit, or an empty list (with the reason logged) when the live sitemaps cannot all be read. */
async function plan() {
  if (!fs.existsSync(SITE_DIR)) {
    console.error("indexnow: _site does not exist; run `npm run build` first.");
    process.exit(2);
  }
  const built = await collect(readBuilt);
  let live;
  try {
    live = await collect(readLive);
  } catch (err) {
    console.warn(`indexnow: ${err.message}; with no baseline every URL would look changed, so the plan is empty`);
    return [];
  }
  const changed = [];
  for (const [url, lastmod] of built) {
    if (!live.has(url) || live.get(url) !== lastmod) changed.push(url);
  }
  const removed = [...live.keys()].filter((url) => !built.has(url));
  console.log(
    `indexnow: ${built.size} URLs built, ${live.size} live, ${changed.length} new or changed, ${removed.length} removed`
  );
  return changed.concat(removed);
}

async function submit(urls) {
  if (!urls.length) {
    console.log("indexnow: nothing to submit");
    return;
  }
  const host = new URL(site.url).host;
  for (let i = 0; i < urls.length; i += BATCH) {
    const urlList = urls.slice(i, i + BATCH);
    const body = JSON.stringify({
      host,
      key: site.indexNowKey,
      keyLocation: `${site.url}/${site.indexNowKey}.txt`,
      urlList,
    });
    try {
      const res = await fetchRetry(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body,
      });
      const text = (await res.text()).trim();
      const label = `${urlList.length} URLs (${i + 1}-${i + urlList.length} of ${urls.length})`;
      if (res.ok) console.log(`indexnow: accepted ${label}: HTTP ${res.status}`);
      else console.warn(`indexnow: rejected ${label}: HTTP ${res.status} ${text}`);
    } catch (err) {
      console.warn(`indexnow: submission failed: ${err.message}`);
    }
  }
}

(async () => {
  if (!site.indexNowKey) {
    console.warn("indexnow: site.json has no indexNowKey; nothing sent");
    return;
  }
  if (mode === "--plan" && file) {
    const changed = await plan();
    writeFileAtomic(file, JSON.stringify(changed, null, 2) + "\n");
    console.log(`indexnow: wrote ${file}`);
  } else if (mode === "--submit" && file) {
    if (!fs.existsSync(file)) {
      console.warn(`indexnow: ${file} not found; nothing sent`);
      return;
    }
    await submit(JSON.parse(fs.readFileSync(file, "utf8")));
  } else if (mode === "--all") {
    const built = await collect(readBuilt);
    await submit([...built.keys()]);
  } else {
    usage();
  }
})();
