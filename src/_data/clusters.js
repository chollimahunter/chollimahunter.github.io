/**
 * clusters.js — one joined record per DPRK actor cluster
 * ==========================================================================
 * src/_data/taxonomy.json is the single source of truth for the cluster tags
 * themselves: their ids, their labels, the short description the home page
 * shows, and the written material each cluster page carries. This file adds
 * nothing to that list. It joins it to everything else the site already holds
 * so a cluster page can be generated rather than hand-written:
 *
 *   profiles    — src/profiles/*.json, matched on cluster_taxonomy
 *   personas    — src/_data/personas.js, matched on campaign
 *   indicators  — src/_data/iocIndex.js, matched on campaign
 *   hunts       — src/_data/hunts/hunts.json, matched on campaign_tags
 *   sources     — every citation carried by any of the above
 *
 * The three match keys live in taxonomy.json (`indicator_campaigns`,
 * `hunt_tags`) rather than here, because they are editorial decisions about
 * what a cluster covers, not mechanics. A cluster that names no keys simply
 * matches nothing, which is the correct result for a tag the site holds
 * charging records for and no indicators.
 *
 * Consumed by:
 *   src/clusters/cluster-page.njk — one page per cluster at /clusters/{id}/
 *   src/index.md                  — the home page cluster cards link here
 */

const fs = require("fs");
const path = require("path");

const taxonomy = require("./taxonomy.json");
const hunts = require("./hunts/hunts.json");
const buildIocIndex = require("./iocIndex.js");
const buildPersonas = require("./personas.js");
const limits = require("./limits.js");
const { compareText } = require("../../scripts/lib/compare.js");

const PROFILES_DIR = path.join(__dirname, "..", "profiles");

/** Rows laid out at once in any list on this page. See src/_data/limits.js. */
const FALLBACK_COUNT = limits.list;

function readProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) =>
      JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, filename), "utf8"))
    )
    .sort((a, b) => compareText(a.display_name || "", b.display_name || ""));
}

function overlaps(values, wanted) {
  return (values || []).some((value) => wanted.has(value));
}

/**
 * Every distinct citation behind a cluster, with what carries it.
 *
 * This is the same idea as src/_data/sources.js, scoped to one cluster and
 * kept separate from it deliberately: that registry answers "what does the
 * whole site rely on", counts indicators per source, and collapses a
 * researcher's post series into one row. Here the useful axis is narrower —
 * which of this cluster's profiles, hunts and indicators a source accounts
 * for — so the rows carry that instead.
 */
function collectSources(profiles, huntEntries, indicators) {
  const byUrl = new Map();

  function add(source, area, label, countKey) {
    if (!source || !source.url) return;
    let entry = byUrl.get(source.url);
    if (!entry) {
      entry = {
        url: source.url,
        title: source.title || source.url,
        publisher: source.publisher || null,
        published: source.date || source.published || null,
        areas: [],
        items: [],
        indicator_count: 0,
        counted: new Set(),
      };
      byUrl.set(source.url, entry);
    }
    if (!entry.publisher && (source.publisher || null)) entry.publisher = source.publisher;
    if (!entry.published) entry.published = source.date || source.published || null;
    // The first sighting of a source may have come from a record whose own
    // citation carries no title, in which case the entry is holding the URL as
    // a placeholder. A later sighting with a real title replaces it.
    if (entry.title === entry.url && source.title) entry.title = source.title;
    if (!entry.areas.includes(area)) entry.areas.push(area);
    if (area === "Indicators") {
      // Count distinct indicators, not citations. A record merged from two runs
      // of the same source carries that URL twice, and counting the pairs would
      // report a source as accounting for more indicators than it does.
      if (!entry.counted.has(countKey)) {
        entry.counted.add(countKey);
        entry.indicator_count += 1;
      }
      return;
    }
    if (label && !entry.items.includes(label)) entry.items.push(label);
  }

  for (const profile of profiles) {
    for (const source of profile.sources || []) add(source, "Profile", profile.display_name);
  }
  for (const hunt of huntEntries) {
    for (const source of hunt.sources || []) add(source, "Hunt", hunt.title);
  }
  for (const record of indicators) {
    for (const source of record.sources || []) add(source, "Indicators", null, record.id);
  }

  // `counted` is bookkeeping for the loop above, not something a page renders.
  for (const entry of byUrl.values()) delete entry.counted;

  return [...byUrl.values()].sort(
    (a, b) =>
      b.indicator_count - a.indicator_count ||
      b.items.length - a.items.length ||
      compareText(a.title, b.title)
  );
}

module.exports = function () {
  const profiles = readProfiles();
  const personas = buildPersonas();
  const iocIndex = buildIocIndex();

  return taxonomy.map((tag) => {
    const indicatorCampaigns = new Set(tag.indicator_campaigns || []);
    const huntTags = new Set(tag.hunt_tags || []);

    const clusterProfiles = profiles.filter((profile) =>
      (profile.cluster_taxonomy || []).includes(tag.label)
    );
    const clusterPersonas = personas.filter((persona) =>
      overlaps(persona.campaign, indicatorCampaigns)
    );
    const clusterHunts = hunts.filter((hunt) => overlaps(hunt.campaign_tags, huntTags));

    // Only indicators the shared search index actually carries. That index is
    // the remote-worker records plus the espionage ones split out of the
    // /remote-workers/ page but kept searchable for exactly these cluster pages
    // (an APT cluster's indicators live in the espionage area, not the
    // remote-worker one). Scoping the search to a cluster cannot then surface
    // anything the count does not, which a reader would catch before we do.
    const searchableRecords = [
      ...iocIndex.remote_workers.records,
      ...iocIndex.espionage.records,
    ];
    const clusterIndicators = searchableRecords.filter((record) =>
      overlaps(record.campaign, indicatorCampaigns)
    );

    const countsByType = {};
    for (const record of clusterIndicators) {
      countsByType[record.ioc_type] = (countsByType[record.ioc_type] || 0) + 1;
    }

    const recent = [...clusterIndicators]
      .sort(
        (a, b) =>
          compareText(b.last_seen || "", a.last_seen || "") ||
          Number(a.extraction.method === "bulk-dataset") -
            Number(b.extraction.method === "bulk-dataset") ||
          compareText(a.value, b.value)
      )
      .slice(0, FALLBACK_COUNT);

    return {
      ...tag,
      url: `/clusters/${tag.id}/`,
      // The newest date among the profiles and hunts the page lists, for the
      // sitemap's lastmod. Empty when none of them carries one.
      last_updated: [...clusterProfiles, ...clusterHunts]
        .map((item) => item.last_updated || "")
        .reduce((a, b) => (b > a ? b : a), ""),
      profiles: clusterProfiles,
      personas: clusterPersonas,
      // A grid of six, with a link to the full listing beside it. The whole set
      // runs to three figures for the IT-worker cluster, which is a page of its
      // own rather than a section of this one.
      personas_preview: clusterPersonas.slice(0, 6),
      hunts: clusterHunts,
      indicators: {
        total: clusterIndicators.length,
        // Ordered biggest-first to match /remote-workers/, so the chip a
        // reader wants most sits next to the "All types" chip.
        counts_by_type: Object.fromEntries(
          Object.entries(countsByType).sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
        ),
        recent,
        // Read by ioc-search.js off the panel element to pre-scope the index
        // it downloads. Pipe-separated because a cluster label may contain a
        // slash and a space ("EtherHiding / UNC5342") but never a pipe.
        scope: (tag.indicator_campaigns || []).join("|"),
      },
      sources: collectSources(clusterProfiles, clusterHunts, clusterIndicators),
    };
  });
};
