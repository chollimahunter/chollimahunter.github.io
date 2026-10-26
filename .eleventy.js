// .eleventy.js — Chollima Hunter 11ty configuration
//
// Deployment target: https://chollimahunter.github.io/ (project root of a
// `<org>.github.io` user/org GitHub Pages site). Sites of this form are
// ALWAYS served from the domain root, so this config intentionally sets
// NO pathPrefix. Do not add one — it will break every absolute link in
// base.njk, the nav, and every downstream expert's page templates.

const fs = require("fs");
const path = require("path");
const { scanMatchKind } = require("./scripts/lib/scan-match-kind.js");
const { compareText } = require("./scripts/lib/compare.js");
const { isOperatorHost } = require("./scripts/lib/operator-hosts.js");
const { explorerUrl, explorerName } = require("./scripts/lib/explorers.js");

module.exports = function (eleventyConfig) {
  // ---------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------
  // findTaxonomy: looks up a taxonomy entry (from src/_data/taxonomy.json,
  // the single source of truth for actor-cluster tags) by its label, so any
  // template that renders a profile's cluster_taxonomy tag as a link can
  // resolve the correct About-page anchor id without a second, hand-kept
  // copy of the tag->anchor mapping. Adding a new taxonomy tag only ever
  // requires editing taxonomy.json — every template that uses this filter
  // (About page, profile layout) picks it up automatically.
  eleventyConfig.addFilter("findTaxonomy", function (taxonomyList, label) {
    return (taxonomyList || []).find((t) => t.label === label) || {};
  });

  // badgeForMethod / labelForMethod: render how an indicator was extracted
  // using the badge modifiers that already exist in tokens.css, so the
  // provenance of every entry in the identifier index is visible without
  // introducing a new set of badge colors. The distinction that matters to a
  // reader is between a value a machine matched literally in a cited report
  // and one a language model asserted — see docs/scrape-dprk-iocs.md.
  const EXTRACTION_METHODS = {
    curated: { badge: "confirmed", label: "CURATED" },
    regex: { badge: "medium", label: "MATCHED IN SOURCE" },
    llm: { badge: "low", label: "AI-EXTRACTED" },
    "bulk-dataset": { badge: "low", label: "BULK DATASET" },
    // A named researcher's assertion, transcribed from their post. Weaker
    // than a report a machine matched literally, stronger than a bulk list:
    // a person stands behind it, but there is no methodology to check.
    "researcher-post": { badge: "medium", label: "RESEARCHER POST" },
    "registry": { badge: "medium", label: "THIRD-PARTY REGISTRY" },
    // A profile on Potential DPRK Profiles that a reviewer rated medium or high.
    "candidate": { badge: "low", label: "UNDER REVIEW" },
  };
  eleventyConfig.addFilter("badgeForMethod", function (method) {
    return (EXTRACTION_METHODS[method] || EXTRACTION_METHODS["bulk-dataset"]).badge;
  });
  eleventyConfig.addFilter("labelForMethod", function (method) {
    return (EXTRACTION_METHODS[method] || EXTRACTION_METHODS["bulk-dataset"]).label;
  });

  // unique: de-duplicated, sorted copy of a list. Used by the DPRK Hunting
  // library index to derive its filter chips (hunt types, query platforms)
  // from _data/hunts/hunts.json rather than from a hand-kept second list
  // that would drift the moment a hunt is added.
  eleventyConfig.addFilter("unique", function (list) {
    return Array.from(new Set(list || [])).sort();
  });

  // paragraphs: lets any prose field be either one string or a list of
  // paragraphs, so a template can always loop and a long field can be broken
  // up in the data without touching the template. A wall of text is a wall of
  // text however well sourced it is, and several of these fields grew past the
  // point a reader will work through them in one block.
  eleventyConfig.addFilter("paragraphs", function (value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return value ? [value] : [];
  });

  // wrapParagraph: wraps a prose fragment in <p>, unless it already opens with
  // a block-level element. A field rendered through `paragraphs` may hold a
  // list where the prose was genuinely a list, and <ul> nested inside <p> is
  // invalid markup that browsers silently repair by closing the paragraph
  // early, which breaks the styling of everything after it.
  const BLOCK_START = /^\s*<(ul|ol|dl|table|blockquote|pre|figure|div|h[1-6])\b/i;
  eleventyConfig.addFilter("wrapParagraph", function (value) {
    const text = value == null ? "" : String(value);
    if (!text.trim()) return "";
    return BLOCK_START.test(text) ? text : "<p>" + text + "</p>";
  });

  // highlightIndicator: the passage a value was pulled from, HTML-escaped, with
  // every occurrence of the value set in <strong> so a reader finds it in a
  // run of neighbouring indicators at a glance. Matches the stored value, the
  // form the page printed (a Gmail address dotted differently, say), the value
  // without its scheme, and an account URL's handle, longest first so a
  // handle inside a URL that also matched is not wrapped twice. Returns safe
  // markup, so the template must not escape it again.
  const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  eleventyConfig.addFilter("highlightIndicator", function (context, record) {
    const text = context == null ? "" : String(context);
    const terms = new Set();
    for (const raw of [record && record.value, record && record.display]) {
      if (!raw) continue;
      const value = String(raw);
      terms.add(value);
      const bare = value.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");
      terms.add(bare);
      if (bare !== value) {
        const handle = bare.split("/").filter(Boolean).pop();
        if (handle && handle.length >= 4) terms.add(handle);
      }
    }
    // Reports often quote only part of a long hex value (an address's first
    // 32 characters, say); a run of 16 or more hex digits inside the value is
    // that value too.
    const hex = String((record && record.value) || "").toLowerCase().replace(/^0x/, "");
    if (/^[0-9a-f]{32,}$/.test(hex)) {
      for (const [run] of text.matchAll(/[0-9a-fA-F]{16,}/g)) if (hex.includes(run.toLowerCase())) terms.add(run);
    }
    const list = [...terms].filter((t) => t && t.length >= 3).sort((a, b) => b.length - a.length);
    if (!list.length) return escapeHtml(text);
    const pattern = new RegExp(list.map(escapeRegExp).join("|"), "gi");
    let out = "";
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      out += escapeHtml(text.slice(last, m.index)) + '<strong class="ioc-result__match">' + escapeHtml(m[0]) + "</strong>";
      last = m.index + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
  });

  // Thousands separators, so a count rendered at build time matches the same
  // count rendered by ioc-search.js (which uses toLocaleString).
  eleventyConfig.addFilter("thousands", function (value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : value;
  });

  // wordCount and firstSentence: a long agency quotation is collapsed behind
  // its first sentence. A sentence ends at . ! ? or an ideographic full stop
  // followed by a space, except after an initial or a common abbreviation
  // (U.S., a.k.a., Mr.), so "the U.S. District Court" is not cut at "U.S.".
  eleventyConfig.addFilter("wordCount", function (value) {
    const text = value == null ? "" : String(value).trim();
    return text ? text.split(/\s+/).length : 0;
  });
  const ABBREVIATION = /(?:^|[\s(])(?:[A-Za-z]|[A-Za-z](?:\.[A-Za-z])+|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Inc|Corp|Co|Ltd|vs|e\.g|i\.e|a\.k\.a)$/;
  eleventyConfig.addFilter("firstSentence", function (value) {
    const text = value == null ? "" : String(value).trim().replace(/\s+/g, " ");
    const end = /[.!?\u3002](?=\s|$)/g;
    let match;
    while ((match = end.exec(text))) {
      if (!ABBREVIATION.test(text.slice(0, match.index))) return text.slice(0, match.index + 1);
    }
    return text;
  });

  // The host of a URL, for link text where the full address would wrap across
  // three lines and say nothing a reader needs: a photograph's credit line
  // reads "Source: commons.wikimedia.org", and the link itself carries the
  // rest. Falls back to the raw value for anything that is not a URL.
  eleventyConfig.addFilter("hostname", function (value) {
    try {
      return new URL(String(value)).hostname.replace(/^www\./, "");
    } catch (err) {
      return value;
    }
  });

  // pathCrumbs: each segment of a URL path with the path up to it, for the
  // breadcrumb trail in partials/structured-data.njk. "/a/b/" gives
  // [{ segment: "a", path: "/a/" }, { segment: "b", path: "/a/b/" }]. Done
  // here rather than in the template because Nunjucks has no split filter
  // and a value set inside a for loop does not survive to the next pass.
  // personasNamed / profileNamed: the personas whose name or alias equals a
  // profile's name or alias, and the reverse. Six charged individuals also
  // have a persona page under the same name with a researcher's indicators
  // on it, and the two pages contradicted each other with no link between
  // them. The match is by exact name only, case-insensitive, so it can be
  // stated as a name match and nothing more.
  const namesOf = (entry) =>
    [entry.display_name, entry.name, ...(entry.aliases || [])]
      .filter((n) => typeof n === "string" && n.trim())
      .map((n) => n.trim().toLowerCase());
  const shareName = (a, b) => {
    const mine = new Set(namesOf(a));
    return namesOf(b).some((n) => mine.has(n));
  };
  eleventyConfig.addFilter("personasNamed", function (personas, profile) {
    if (!profile || !Array.isArray(personas)) return [];
    return personas.filter((persona) => shareName(profile, persona));
  });
  eleventyConfig.addFilter("profileNamed", function (profiles, persona) {
    if (!persona || !Array.isArray(profiles)) return null;
    return profiles.find((profile) => shareName(profile, persona)) || null;
  });

  // rulesetEntryCount: the entry count a scan's ruleset_version string
  // records ("repo-scan-ruleset.json @ 2026-08-30 (117 entries)"), so the
  // scanner page can say when the live ruleset has outgrown the last run.
  eleventyConfig.addFilter("rulesetEntryCount", function (version) {
    const m = /\((\d+) entries\)/.exec(String(version || ""));
    return m ? Number(m[1]) : null;
  });

  eleventyConfig.addFilter("pathCrumbs", function (url) {
    const segments = String(url || "").split("/").filter(Boolean);
    // A last segment with an extension (404.html) is a file, not a directory,
    // so it takes no trailing slash; otherwise the crumb disagrees with the
    // page's own canonical URL.
    return segments.map((segment, i) => {
      const isFile = i === segments.length - 1 && /.[a-z0-9]+$/i.test(segment);
      return { segment, path: "/" + segments.slice(0, i + 1).join("/") + (isFile ? "" : "/") };
    });
  });

  // Nunjucks' own "slice" filter splits a list into N groups (a column-layout
  // helper), not "take the first N items" -- this is the latter, for showing
  // a bounded sample from a large bulk dataset without dumping it all.
  eleventyConfig.addFilter("limit", function (list, n) {
    return (list || []).slice(0, n);
  });

  // ofType: the entries of an indicator list carrying one ioc_type. A template
  // cannot do this with `set` inside a `for`, because Nunjucks scopes a
  // loop-body assignment to the loop, so the answer never escapes it. The
  // candidate table needs it to tell "the source published no number" from
  // "nobody has looked one up yet".
  eleventyConfig.addFilter("ofType", function (list, type) {
    return (list || []).filter((entry) => entry && entry.type === type);
  });

  // flattenKey and countBy: the counts a filter-chip group shows, for data a
  // template would otherwise have to tally with `set` inside a `for`, which
  // Nunjucks scopes to the loop. `categories | flattenKey("indicators") |
  // countBy("priority")` gives {"1": n, "2": n, "3": n} in key order.
  eleventyConfig.addFilter("flattenKey", function (list, key) {
    return (list || []).flatMap((entry) => (entry && entry[key]) || []);
  });
  // explorerUrl / explorerName: the public block-explorer page for an
  // on-chain address or transaction, and the explorer's name, from
  // scripts/lib/explorers.js. Null for a chain with no explorer listed.
  eleventyConfig.addFilter("explorerUrl", function (value, chain, kind) {
    return explorerUrl(value, chain, kind || "address");
  });
  eleventyConfig.addFilter("explorerName", function (chain) {
    return explorerName(chain);
  });

  eleventyConfig.addFilter("countBy", function (list, key) {
    const counts = {};
    for (const entry of list || []) {
      const value = String(entry && entry[key]);
      counts[value] = (counts[value] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
  });

  // countDistinctIn: how many entries carry each value of `field` somewhere in
  // their `key` list, an entry counted once however often it repeats a value.
  // The /hunts/ query-language chips need it: a hunt with three Sigma queries is
  // one hunt, so `hunts | countDistinctIn("queries", "platform")` tallies hunts,
  // which is what the chip filters, rather than queries.
  eleventyConfig.addFilter("countDistinctIn", function (list, key, field) {
    const counts = {};
    for (const entry of list || []) {
      const values = new Set(((entry && entry[key]) || []).map((item) => String(item && item[field])));
      for (const value of values) counts[value] = (counts[value] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  });

  // countValues: how many entries carry each value of an array-valued `key`,
  // an entry counted once per value. The /hunts/ OS chips use it on each hunt's
  // `platforms` list: `hunts | countValues("platforms")`.
  eleventyConfig.addFilter("countValues", function (list, key) {
    const counts = {};
    for (const entry of list || []) {
      for (const value of new Set(((entry && entry[key]) || []).map(String))) counts[value] = (counts[value] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  });

  // A raw ISO 8601 timestamp (e.g. from a scan_result's matched_at) rendered
  // as something a reader can actually parse at a glance, in UTC so it means
  // the same thing to every visitor regardless of their own timezone.
  eleventyConfig.addFilter("prettyDate", function (iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return (
      d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    );
  });

  // A scan match's `location` is a full GitHub blob URL -- readable to a
  // machine, not to a person scanning a table. This reduces it to
  // "owner/repo — filename", the two facts a reviewer actually needs to
  // decide whether to open the link, while the link itself still points at
  // the full blob URL. Falls back to the raw value for anything that isn't
  // a github.com/.../blob/... URL, rather than guessing.
  eleventyConfig.addFilter("githubLocationLabel", function (url) {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)$/.exec(url || "");
    if (!m) return url;
    const [, repo, filePath] = m;
    const filename = filePath.split("/").pop();
    return `${repo} — ${filename}`;
  });

  // scanMatchKind: "research" when a repo-scanner match's path and repository
  // name look like detection tooling or a published indicator collection
  // (JPCERTCC/Contagious-Interview-IoCs, a YARA ruleset, a PolinRider cleanup
  // scanner) rather than a possibly compromised project -- the two render
  // identically in the scan-match table otherwise. The heuristic itself lives
  // in scripts/lib/scan-match-kind.js, shared with scripts/run-repo-scan.js
  // so a future live run can record the same classification on each match
  // going forward. A run's matches predate the `kind` field, so the template
  // calls this filter as a fallback rather than assuming `match.kind` is set.
  eleventyConfig.addFilter("scanMatchKind", function (match) {
    return scanMatchKind(match);
  });

  // iocLabel: the text shown for an indicator's value. A compromised repository
  // is stored as owner/repo and shown as the full https://github.com/owner/repo
  // address, always as plain text, because these repositories carry live
  // malware. Every other record shows its value as stored. ioc-search.js
  // mirrors this in displayValue().
  eleventyConfig.addFilter("iocLabel", function (record) {
    const value = record.value;
    return record.ioc_type === "compromised_repository" && /^[\w.-]+\/[\w.-]+$/.test(value)
      ? `https://github.com/${value}`
      : value;
  });

  // isOperatorSite: true when a URL or bare host is on a site the operators
  // host or control (iocIndex.operator_hosts), which a template renders as
  // text rather than a link. False for anything else, a malformed URL
  // included. scripts/check-site.js fails the build on any such link.
  let operatorHostSet = null;
  let operatorHostList = null;
  eleventyConfig.addFilter("isOperatorSite", function (value) {
    const list = require("./src/_data/iocIndex.js")().operator_hosts;
    if (list !== operatorHostList) {
      operatorHostList = list;
      operatorHostSet = new Set(list);
    }
    return isOperatorHost(operatorHostSet, value);
  });

  // ---------------------------------------------------------------------
  // Passthrough copy
  // ---------------------------------------------------------------------
  // Static assets (CSS today; leave room for future fonts/JS/static files —
  // NOTE: the design brief forbids external image dependencies, so this is
  // for local, checked-in static files only, not a place to add raster
  // images of unverified provenance).
  eleventyConfig.addPassthroughCopy("src/assets");

  // Maintainer-only pages live in the private _drafts/ checkout, which is not
  // part of this repository. They are registered only in a private build
  // (src/_data/privatePages.js), so a production build cannot write them.
  const privateModule = path.join(__dirname, "_drafts", "private", "eleventy.js");
  if (require("./src/_data/privatePages.js")() && fs.existsSync(privateModule)) {
    require(privateModule).register(eleventyConfig);
  }

  // Root-level files browsers and installers look for by convention:
  // the web app manifest, and a bare /favicon.ico for clients that
  // request it directly instead of reading base.njk's <link rel="icon">.
  eleventyConfig.addPassthroughCopy({
    "src/site.webmanifest": "site.webmanifest",
    "src/assets/img/favicon.ico": "favicon.ico",
    // The licence terms the About page states, served from the site itself
    // because the repository is private and cannot be linked to.
    "LICENSE": "license.txt",
  });

  // ---------------------------------------------------------------------
  // Collections — RESERVED NAMES
  // ---------------------------------------------------------------------
  // The collection names below are reserved for specific downstream experts.
  // Each expert registers its OWN collection in its own code (site-scaffold
  // does not author their page templates) — this block exists purely as a
  // naming registry so no two experts collide on the same collection name.
  // If you are extending this file, check this list first.
  //
  //   "profiles"           -> profile-curator
  //                           (reads src/profiles/*.json, one page per file
  //                           at /profiles/{slug}/; registered immediately
  //                           below by profile-curator)
  //   "hunts"               -> intel-content
  //                           (reads _data/hunts/hunts.json, rendered at
  //                           /hunts/)
  //   "scanResults"         -> repo-scanner (RESERVED, optional)
  //                           repo-scanner renders _data/scanResults/latest.json
  //                           directly in src/repo-scanner/index.njk rather
  //                           than via an 11ty collection. This name is
  //                           reserved in case repo-scanner later judges a
  //                           collection is cleaner — do not reuse it for
  //                           anything else in the meantime.
  //   "etherhidingFindings"  -> etherhiding-tracker (RESERVED, optional)
  //                           Same situation as scanResults: etherhiding-
  //                           tracker renders _data/etherhidingFindings/latest.json
  //                           directly in src/etherhiding/results.njk. Name
  //                           reserved for a future collection-based rewrite.
  //
  // site-scaffold does not itself call eleventyConfig.addCollection() for
  // any of the above — each owning expert wires up its own collection (or,
  // for scanResults/etherhidingFindings, its own direct data-file read)
  // against its own data directory.

  // --- profile-curator: "profiles" collection -----------------------------
  // Plain JSON is NOT one of this site's templateFormats (see below), so a
  // bare src/profiles/{slug}.json data file is never auto-rendered into a
  // page by 11ty's normal template pipeline (that only works for recognized
  // template engines - json isn't one). Instead this collection reads every
  // src/profiles/*.json file directly off disk with Node's fs, parses it,
  // and exposes the parsed objects as collection items. The actual page-per-
  // profile output is produced by src/profiles/profile-page.njk, a thin
  // Nunjucks template that paginates over `collections.profiles` (size: 1,
  // alias: "profile") and sets `permalink: "/profiles/{{ profile.slug }}/"`.
  // Each item here matches the profile JSON shape exactly (no
  // transformation applied), so `profile.slug`, `profile.display_name`,
  // `profile.sources`, etc. are available as-is in templates.
  eleventyConfig.addCollection("profiles", function () {
    const dir = path.join(__dirname, "src", "profiles");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => {
        const raw = fs.readFileSync(path.join(dir, filename), "utf8");
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new Error(
            `profile-curator: failed to parse ${filename} as JSON: ${err.message}`
          );
        }
      })
      // Ordered for the grids, which every listing of this collection is: DPRK
      // nationals with a photograph, then anyone else with a photograph, then
      // the remaining nationals, then everyone else, alphabetical within each
      // band. A profile is a DPRK national unless it sets
      // `name_korean_not_applicable`, which is what the facilitator profiles
      // do. Faces come before blank tiles because the page opens on the people
      // it exists to show, and nationals come before facilitators within each.
      .sort((a, b) => rankProfile(a) - rankProfile(b) || compareText(a.display_name || "", b.display_name || ""));
  });

  function rankProfile(profile) {
    const national = !profile.name_korean_not_applicable;
    const photo = Boolean(profile.photo_slot && profile.photo_slot.image_path);
    if (national && photo) return 0;
    if (photo) return 1;
    if (national) return 2;
    return 3;
  }

  // --- Profile content requirements (build-time, fail loudly) -------------
  // A profile that shows a photograph must also carry the Korean rendering of
  // the name. The two travel together on this site: a face without the Hangul
  // reads as a half-finished entry, and it is easy to add a portrait and forget
  // the name. Enforced here rather than left to review, because a missing field
  // otherwise renders as silently-absent markup rather than an error.
  eleventyConfig.on("eleventy.before", () => {
    const dir = path.join(__dirname, "src", "profiles");
    if (!fs.existsSync(dir)) return;
    const offenders = [];
    for (const filename of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const profile = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8"));
      const koreanNameRequired =
        profile.photo_slot &&
        profile.photo_slot.image_path &&
        !profile.name_korean &&
        // A profile may declare the requirement inapplicable, which is the case
        // for a subject who is not a DPRK national: there is no Korean
        // rendering of a US facilitator's name to publish, and inventing one
        // would be worse than omitting it. The field has to say why, so the
        // exemption is a stated editorial decision rather than a silent gap.
        !profile.name_korean_not_applicable;
      if (koreanNameRequired) {
        offenders.push(filename);
      }
    }
    if (offenders.length) {
      throw new Error(
        "Profiles with a photograph must set `name_korean`, or `name_korean_not_applicable` " +
          "with the reason (see CONTENT_GUIDE.md). Missing in: " + offenders.join(", ")
      );
    }
  });

  // ---------------------------------------------------------------------
  // Markdown / templating
  // ---------------------------------------------------------------------
  // Standard 11ty defaults (markdown-it via the built-in markdownLibrary)
  // are sufficient for this site's needs; no custom markdown-it plugins
  // are required at scaffold time.

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    // No pathPrefix: site is served at the domain root of
    // https://chollimahunter.github.io/
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "html"],
  };
};
