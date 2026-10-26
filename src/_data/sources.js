/**
 * sources.js — the site's single source-of-truth registry of citations
 * ==========================================================================
 * Every page on this site cites public records, but each area used to keep its
 * own citations in its own shape: profiles carry `sources[]`, hunts carry
 * `sources[]`, IOC rulesets carry `sources[]`, bulk datasets carry a single
 * `source{}`, and the scraper writes its own per-indicator source objects.
 *
 * This file reads all of them, normalizes to one shape, and deduplicates by
 * URL, so /sources/ can answer "what does this site rely on, and what
 * does each source account for?" in one place rather than per-section.
 *
 * There is deliberately no separate hand-maintained list of sources anywhere.
 * Adding a citation to a profile, hunt, ruleset entry or scrape source is what
 * puts it here — a second list would drift from the first the moment one of
 * them was edited.
 *
 * Consumed by src/sources/index.njk.
 */

const fs = require("fs");
const path = require("path");

const iocIndex = require("./iocIndex.js");
const { readJsonIfPresent } = require("../../scripts/lib/read-json.js");
const { recordsFromDossiers } = require("../../scripts/lib/dossiers.js");
const { compareText } = require("../../scripts/lib/compare.js");
const { canonicalPublisher } = require("../../scripts/lib/publishers.js");
const { sourceKey } = require("../../scripts/lib/source-url.js");
const site = require("./site.json");

const DATA_DIR = __dirname;
const IOCS_DIR = path.join(DATA_DIR, "iocs");
const PROFILES_DIR = path.join(DATA_DIR, "..", "profiles");
const DOSSIERS_PATH = path.join(IOCS_DIR, "x-dossiers.json");
const REGISTRIES_PATH = path.join(IOCS_DIR, "third-party-registries.json");
const OBSERVATIONS_PATH = path.join(IOCS_DIR, "direct-observations.json");

const readJson = readJsonIfPresent;

/**
 * One registry entry per distinct URL. `used_by` records which areas of the
 * site rely on it and how many items each contributes, which is what makes the
 * page useful beyond a flat link list.
 */
function makeRegistry() {
  const byUrl = new Map();

  function add(source, area, itemLabel) {
    if (!source || !source.url) return;
    // A page this site read for itself (an account, a listing) has no
    // publication date of its own; the date it was read is the one that
    // matters, so it stands in.
    if (area === "Direct observations" && !source.date && !source.published && source.pulled_at) {
      source = { ...source, published: source.pulled_at };
    }
    const url = String(source.url).trim();
    if (!url) return;
    source = { ...source, publisher: canonicalPublisher(url, source.publisher) };
    const key = sourceKey(url);
    let entry = byUrl.get(key);
    if (!entry) {
      entry = {
        url,
        title: source.title || url,
        publisher: source.publisher || null,
        published: source.date || source.published || null,
        type: source.type || null,
        used_by: {},
        items: [],
      };
      byUrl.set(key, entry);
    }
    // First non-empty value wins for the descriptive fields, so a richer
    // citation isn't overwritten by a barer one for the same URL.
    if (!entry.publisher && source.publisher) entry.publisher = source.publisher;
    if (!entry.published && (source.date || source.published)) {
      entry.published = source.date || source.published;
    }
    if (!entry.type && source.type) entry.type = source.type;
    if ((!entry.title || entry.title === url) && source.title) entry.title = source.title;

    entry.used_by[area] = (entry.used_by[area] || 0) + 1;
    if (itemLabel && entry.items.length < 40 && !entry.items.includes(itemLabel)) {
      entry.items.push(itemLabel);
    }
  }

  // --- Profiles -----------------------------------------------------------
  if (fs.existsSync(PROFILES_DIR)) {
    for (const file of fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json"))) {
      const profile = readJson(path.join(PROFILES_DIR, file), null);
      if (!profile) continue;
      for (const source of profile.sources || []) {
        add(source, "Profiles", profile.display_name);
      }
    }
  }

  // --- Hunts --------------------------------------------------------------
  for (const hunt of readJson(path.join(DATA_DIR, "hunts", "hunts.json"), [])) {
    for (const source of hunt.sources || []) add(source, "Hunts", hunt.title);
  }

  // --- Curated IOC rulesets ----------------------------------------------
  for (const [file, area] of [
    ["repo-scan-ruleset.json", "Repo scanner ruleset"],
    ["etherhiding-watchlist.json", "EtherHiding watchlist"],
  ]) {
    for (const entry of readJson(path.join(IOCS_DIR, file), [])) {
      for (const source of entry.sources || []) add(source, area, entry.value);
    }
  }

  // --- Researcher posts ---------------------------------------------------
  // The hand-transcribed dossiers in iocs/x-dossiers.json. These were absent
  // from this registry entirely: the records reach the index through
  // iocIndex.js, but nothing walked the dossier file here, so every post that
  // accounts for an indicator was missing from the source list — the single
  // largest body of citations on the site after the scraped reports.
  for (const record of recordsFromDossiers(readJson(DOSSIERS_PATH, null))) {
    for (const source of record.sources || []) {
      add(source, "Researcher posts", source.section || null);
    }
  }

  // --- Third-party registries ---------------------------------------------
  for (const record of recordsFromDossiers(readJson(REGISTRIES_PATH, null))) {
    for (const source of record.sources || []) {
      add(source, "Third-party registries", source.section || null);
    }
  }

  // --- Direct observations ------------------------------------------------
  // Pages this site read a value from itself: a live account, a marketplace
  // listing. Same dossier shape and loader as the two files above, and absent
  // here for the same reason the researcher posts once were.
  for (const record of recordsFromDossiers(readJson(OBSERVATIONS_PATH, null))) {
    for (const source of record.sources || []) {
      add(source, "Direct observations", source.section || null);
    }
  }

  // --- Bulk identifier datasets ------------------------------------------
  // Every bulk dataset file, not only the identifier one: the package-version
  // datasets cite Sonatype and OpenSourceMalware and were missing from the
  // registry, which contradicted the page's promise that a citation anywhere
  // puts it here.
  for (const file of ["itworker-datasets.json", "malicious-package-versions.json", "osm-malicious-package-versions.json"]) {
    for (const dataset of readJson(path.join(IOCS_DIR, file), [])) {
      if (dataset.source) add(dataset.source, "Identifier datasets", dataset.title);
    }
  }

  // --- Observable-indicator register --------------------------------------
  // tradecraft.json cites by key into its own `sources` map rather than
  // repeating a source object on each of its rows, so the row count a source
  // accounts for is recovered here instead of read off the entry.
  const tradecraft = readJson(path.join(DATA_DIR, "tradecraft.json"), null);
  if (tradecraft) {
    for (const category of tradecraft.categories || []) {
      for (const row of category.indicators || []) {
        for (const key of row.sources || []) {
          add(tradecraft.sources[key], "Observable indicators", row.indicator);
        }
      }
    }
  }

  // --- Scraped indicators -------------------------------------------------
  const scraped = readJson(path.join(IOCS_DIR, "scraped-iocs.json"), { records: [] });
  for (const record of scraped.records || []) {
    for (const source of record.sources || []) add(source, "Scraped indicators", null);
  }

  // A scraped record carries its source's URL but not always its title or
  // publisher; the scrape-source list has both, so it fills the gaps.
  for (const known of readJson(path.join(IOCS_DIR, "scrape-sources.json"), { sources: [] }).sources || []) {
    const entry = byUrl.get(sourceKey(known.url));
    if (!entry) continue;
    if ((!entry.title || entry.title === entry.url) && known.title) entry.title = known.title;
    if (!entry.publisher && known.publisher) entry.publisher = known.publisher;
  }
  // Publication dates checked by hand, with evidence; see the file's _comment
  // for what was and was not accepted. They win over a date on the citation,
  // which for scraped sources is whatever the extractor last read.
  const found = readJson(path.join(DATA_DIR, "..", "..", "scripts", "data", "source-dates.json"), { dates: {} }).dates || {};
  for (const [url, info] of Object.entries(found)) {
    const entry = byUrl.get(sourceKey(url));
    if (entry && info.date) entry.published = info.date;
  }

  return [...byUrl.values()]
    .map((entry) => ({
      ...entry,
      total: Object.values(entry.used_by).reduce((sum, n) => sum + n, 0),
      areas: Object.keys(entry.used_by).sort(),
    }))
    .sort((a, b) => b.total - a.total || compareText(a.title, b.title));
}

/**
 * One row per source, not per page.
 *
 * The registry is keyed by URL, so a publisher cited for many pages had a row
 * for every one: 103 for haydenmckenzie.com, 158 for AhnLab's ASEC blog. Rows
 * are grouped here by the source behind the URL, and a group carries every
 * page it accounts for as `posts`.
 *
 * What counts as one source:
 * - A site: its registrable domain, so asec.ahnlab.com and ahnlab.com are one.
 * - An account on a shared platform, where each account is a different
 *   publisher: x.com/<handle>, github.com/<owner>, a tistory or github.io
 *   subdomain.
 * - This site's own observations, wherever the page sat: one row, Chollima
 *   Hunter, since the account read is the evidence rather than the author.
 * - A copy of a page: a Wayback capture groups with the site it captured, and
 *   an Obsidian Publish file URL groups with the site it publishes.
 */
const X_STATUS = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^\/?#]+)(?:\/status\/\d+)?/i;

// Obsidian Publish serves a site's Markdown from a shared host; the site id
// maps it back to the domain readers know.
const PUBLISH_SITES = { e938bc08985e9e81ff7c128ff0f45f3c: "haydenmckenzie.com" };

// Hosts where the first path segment is the account, and so the publisher.
const ACCOUNT_HOSTS = new Set([
  "github.com", "gitlab.com", "dev.to", "hub.docker.com", "huggingface.co",
  "keybase.io", "linkedin.com", "medium.com", "t.me", "npmjs.com",
  "registry.npmjs.org", "pipu.cc", "etherscan.io", "docs.google.com",
  "drive.google.com", "blog.naver.com", "youtube.com", "facebook.com",
  "reddit.com", "pastebin.com",
]);
// Hosts that hand every user a subdomain, which is then the publisher.
const SUBDOMAIN_PLATFORMS = [
  "tistory.com", "blogspot.com", "blogspot.kr", "wordpress.com", "github.io",
  "vercel.app", "netlify.app", "substack.com", "medium.com", "pages.dev", "gitbook.io", "notion.site",
];
const SECOND_LEVEL = new Set([
  "co.kr", "or.kr", "go.kr", "re.kr", "ac.kr", "com.cn", "gov.cn", "co.uk",
  "org.uk", "gov.uk", "com.au", "co.jp", "ne.jp", "or.jp", "go.jp", "ac.jp",
  "com.tw", "com.br", "co.in",
]);

// The name a group goes by where its pages spell the publisher several ways
// or name the author rather than the site. A conference is its venue.
const FIRST_PARTY_KEY = "chollima-hunter";
const GROUP_NAMES = {
  [FIRST_PARTY_KEY]: "Chollima Hunter",
  "paloaltonetworks.com": "Palo Alto Networks Unit 42",
  "justice.gov": "U.S. Department of Justice",
  "treasury.gov": "U.S. Department of the Treasury",
  "rewterz.com": "Rewterz",
  "kmsec.uk": "Kieran Miyamoto (kmsec)",
  "blackhat.com": "Black Hat",
  "sekoia.com": "Sekoia",
};

function registrableDomain(host) {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** { key, url, label } for the source a cited URL belongs to. */
function sourceOf(entry) {
  let parsed;
  try {
    parsed = new URL(entry.url);
  } catch {
    return { key: entry.url, url: entry.url, label: entry.title };
  }
  let host = parsed.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);

  // Every page this site read for itself is one source, Chollima Hunter,
  // whatever host the page sat on: the observation is the evidence, and a
  // reader looking for first-party records should find them in one row.
  if (entry.publisher && /^Chollima Hunter/.test(entry.publisher)) {
    return { key: FIRST_PARTY_KEY, url: `${site.url}/`, label: "Chollima Hunter" };
  }

  const x = entry.url.match(X_STATUS);
  if (x) return { key: `x.com/${x[1].toLowerCase()}`, url: `https://x.com/${x[1]}`, label: `@${x[1]}` };

  if (host === "web.archive.org") {
    const original = parsed.pathname.replace(/^\/web\/[^/]+\//, "");
    if (/^https?:/i.test(original)) return sourceOf({ ...entry, url: original });
  }
  if (host.endsWith("obsidian.md") && segments[0] === "access" && PUBLISH_SITES[segments[1]]) {
    const site = PUBLISH_SITES[segments[1]];
    return { key: site, url: `https://${site}/`, label: site };
  }
  if (host === "raw.githubusercontent.com" || host === "gist.github.com") host = "github.com";
  if (host.endsWith(".blog.naver.com")) host = "blog.naver.com";

  if (ACCOUNT_HOSTS.has(host)) {
    const account = segments[0] || "";
    return { key: `${host}/${account.toLowerCase()}`, url: `https://${host}/${account}`, label: `${host}/${account}` };
  }
  if (SUBDOMAIN_PLATFORMS.some((p) => host.endsWith(`.${p}`))) {
    return { key: host, url: `https://${host}/`, label: host };
  }
  const domain = registrableDomain(host);
  return { key: domain, url: `https://${domain}/`, label: domain };
}

/** The spelling a group's entries use most, the longest on a tie. */
function commonest(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || null;
}

function groupBySource(registry) {
  const groups = new Map();
  for (const entry of registry) {
    const source = sourceOf(entry);
    if (!groups.has(source.key)) groups.set(source.key, { source, entries: [] });
    groups.get(source.key).entries.push(entry);
  }

  const out = [];
  for (const { source, entries } of groups.values()) {
    const isX = source.key.startsWith("x.com/");
    // A source cited for one page keeps that page as its row, unless it is an
    // X post, which reads better addressed to its account.
    if (entries.length === 1 && !isX) {
      out.push(entries[0]);
      continue;
    }
    const publisher = commonest(entries.map((e) => e.publisher));
    const group = {
      url: source.url,
      title: isX ? source.label : GROUP_NAMES[source.key] || publisher || source.label,
      publisher: GROUP_NAMES[source.key] || publisher,
      published: null,
      type: entries[0].type,
      used_by: {},
      items: [],
      posts: [],
      post_noun: isX ? "post" : "page",
    };
    for (const entry of entries) {
      for (const [area, count] of Object.entries(entry.used_by)) {
        group.used_by[area] = (group.used_by[area] || 0) + count;
      }
      for (const item of entry.items) {
        if (group.items.length < 40 && !group.items.includes(item)) group.items.push(item);
      }
      group.posts.push({ url: entry.url, title: isX ? null : entry.title, published: entry.published || null });
    }
    // Newest first, and undated last rather than sorted as "".
    group.posts.sort((a, b) => compareText(b.published || "", a.published || ""));
    const dates = group.posts.map((post) => post.published).filter(Boolean);
    const first = dates[dates.length - 1];
    const last = dates[0];
    group.published = !first ? null : first === last ? first : `${first} to ${last}`;
    group.total = Object.values(group.used_by).reduce((sum, n) => sum + n, 0);
    group.areas = Object.keys(group.used_by).sort();
    // indicator_count is set by the caller, which sums the pages' own counts.
    out.push(group);
  }
  return out;
}

module.exports = function () {
  const registry = makeRegistry();

  // How many indicators in the unified index came from each source. Derived
  // from the index rather than counted while walking the citations, because
  // that is the only place the question can be answered exactly: a bulk
  // dataset is one `source{}` object but contributes one record per entry,
  // and one indicator reported by two sources counts under both.
  const indicatorCounts = new Map();
  for (const record of iocIndex().records) {
    for (const source of record.sources) {
      if (!source.url) continue;
      const key = sourceKey(source.url);
      indicatorCounts.set(key, (indicatorCounts.get(key) || 0) + 1);
    }
  }
  for (const entry of registry) {
    entry.indicator_count = indicatorCounts.get(sourceKey(entry.url)) || 0;
  }

  // Collapse after the per-URL counts are attached: an account's count is the
  // sum of its posts', and each post's own count is only knowable by its URL.
  const all = groupBySource(registry);
  for (const entry of all) {
    for (const post of entry.posts || []) {
      post.indicator_count = indicatorCounts.get(sourceKey(post.url)) || 0;
    }
    if (entry.posts) {
      entry.indicator_count = entry.posts.reduce((sum, post) => sum + post.indicator_count, 0);
    }
  }
  all.sort((a, b) => b.indicator_count - a.indicator_count || compareText(a.title, b.title));

  const byArea = {};
  for (const entry of all) {
    for (const area of entry.areas) byArea[area] = (byArea[area] || 0) + 1;
  }
  const publishers = new Set(all.map((e) => e.publisher).filter(Boolean));
  return {
    all,
    total: all.length,
    counts_by_area: byArea,
    publisher_count: publishers.size,
  };
};
