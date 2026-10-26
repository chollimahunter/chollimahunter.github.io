/**
 * ioc-search.js — client-side search for /remote-workers/ (Remote Workers)
 * ==========================================================================
 * Downloads the compact index emitted by src/ioc-index.njk, then filters and
 * renders it in the browser. This is the only JavaScript the site ships.
 *
 * Progressive enhancement: the page renders the 50 most recent indicators as
 * real link rows at build time. This script hides that fallback and
 * reveals the search controls only once the index has actually loaded, so a
 * reader whose browser blocks scripts — or whose fetch fails — keeps a working
 * page instead of getting an empty one.
 *
 * Every value rendered here originates from a scraped third-party page, so
 * results are built with createElement/textContent throughout. Nothing from
 * the index is ever assigned to innerHTML.
 *
 * A result is a row in the indicator table (partials/ioc-table.njk) whose
 * value links to the indicator's own page at /indicators/{id}/, built by
 * src/indicators/indicator-page.njk — every field, citation and context quote
 * lives there, not here. The row markup mirrors
 * src/_includes/partials/ioc-result.njk. If one changes, change the other, or
 * the page will look different depending on whether JavaScript ran. Pressing a
 * column header sorts the whole result set, not only the rows on screen; see
 * wireHeaders().
 *
 * A cluster page at /clusters/{id}/ uses the same script and the same index,
 * narrowed to one cluster by a `data-ioc-scope` attribute on the panel holding
 * the activity-cluster labels that page covers. Scoping is applied once at
 * startup rather than as a fourth filter dimension, so everything downstream —
 * the counts, the "show more" arithmetic, the empty-result wording — describes
 * the cluster without knowing it is looking at a subset.
 *
 * Where the download controls are present (partials/ioc-download-controls.njk,
 * on /remote-workers/, a cluster page and /repo-scanner/ — not the compact
 * search-only widget on the home page), this script also exports whatever the
 * current search text, filter chips and download-panel type override have
 * narrowed `matches` to, as STIX 2.1, CSV, plain text or JSON. See the "Export
 * / download" section below for the STIX pattern-per-type mapping.
 */
(function () {
  "use strict";

  var U = window.siteUtils;
  var el = U.el;

  // The single-file index, named in error messages and the no-script fallback.
  var INDEX_URL = "/assets/data/ioc-index.json";
  // What the search actually fetches: the same index in two parts. The core
  // file is everything but the context quotes and is enough to search values,
  // names, personas and source titles; the quotes are 42% of the bytes and
  // arrive second, after which the current query is run again so a phrase
  // from a report starts matching. See src/ioc-index-core.njk.
  var CORE_URL = "/assets/data/ioc-search.json";
  var CONTEXTS_URL = "/assets/data/ioc-contexts.json";
  // base.njk stamps the index build date into a meta tag; carried as a query
  // string so a rebuilt index is never served from a stale browser cache.
  var versionMeta = document.querySelector('meta[name="ioc-index-version"]');
  var INDEX_VERSION = versionMeta ? versionMeta.getAttribute("content") : "";
  function versioned(url) {
    return url + (INDEX_VERSION ? "?v=" + encodeURIComponent(INDEX_VERSION) : "");
  }
  // A short first page keeps the index skimmable; expanding then jumps in
  // large steps, because someone who asks for more is browsing the whole set
  // rather than paging through it fifty at a time.
  var INITIAL_COUNT = 50;
  var MORE_COUNT = 1000;
  var DEBOUNCE_MS = 120;

  // A fixed UUID minted once for this site (see the report for how), used as
  // the namespace for every deterministic UUIDv5 id the STIX export below
  // generates. Fixed so that downloading the same indicator twice — today, or
  // after a rebuild — produces the same indicator--id both times, which is
  // what makes two downloads diffable.
  var STIX_NAMESPACE = "b454106f-0a80-4cf5-9523-695060e4ae3f";
  // The STIX 2.1 spec's own pre-defined TLP:WHITE marking-definition (section
  // 7.2.1), reused here as the closest built-in equivalent of TLP:CLEAR: every
  // record in this index is drawn from an already-public report, so nothing
  // exported carries a sharing restriction.
  var TLP_WHITE_ID = "marking-definition--613f2e26-407d-48c7-9eca-b8e91df99dc9";
  var TLP_WHITE_OBJECT = {
    type: "marking-definition",
    spec_version: "2.1",
    id: TLP_WHITE_ID,
    created: "2017-01-20T00:00:00.000Z",
    definition_type: "tlp",
    name: "TLP:WHITE",
    definition: { tlp: "white" },
  };

  // Mirrors EXTRACTION_METHODS in .eleventy.js.
  var METHODS = {
    curated: { badge: "confirmed", label: "CURATED" },
    regex: { badge: "medium", label: "MATCHED IN SOURCE" },
    llm: { badge: "low", label: "AI-EXTRACTED" },
    "bulk-dataset": { badge: "low", label: "BULK DATASET" },
    "researcher-post": { badge: "medium", label: "RESEARCHER POST" },
    "registry": { badge: "medium", label: "THIRD-PARTY REGISTRY" },
    "candidate": { badge: "low", label: "UNDER REVIEW" },
  };

  var panel = document.querySelector("[data-ioc-search]");
  // The results table's wrapper (partials/ioc-table.njk), shown once the index
  // loads, and the body this script fills.
  var resultsList = document.querySelector("[data-ioc-results]");
  var resultsTable = resultsList ? resultsList.querySelector("table") : null;
  var resultsBody = resultsTable ? resultsTable.tBodies[0] : null;
  var fallbackList = document.querySelector("[data-ioc-fallback]");
  var countEl = document.querySelector("[data-ioc-count]");
  var moreWrap = document.querySelector("[data-ioc-more]");
  var moreButton = document.querySelector("[data-ioc-more-button]");
  var input = document.getElementById("ioc-search-input");
  // Present on /remote-workers/, a cluster page and /repo-scanner/ only — see
  // partials/ioc-download-controls.njk. Left null (and every export function
  // below no-ops) on the compact search-only widget on the home page.
  var downloadFormat = document.querySelector("[data-ioc-download-format]");
  var downloadButton = document.querySelector("[data-ioc-download-button]");
  var downloadStatus = document.querySelector("[data-ioc-download-status]");

  if (!panel || !resultsBody || !input) return;

  // A page can name an index of its own with data-ioc-index. /repo-scanner/
  // searches a few thousand repository indicators that no other page carries,
  // built as one file with its context quotes inline, so there is no second
  // fetch. Without the attribute the shared identity index above is used.
  var ownIndex = panel.getAttribute("data-ioc-index");
  if (ownIndex) {
    INDEX_URL = ownIndex;
    CORE_URL = ownIndex;
    CONTEXTS_URL = null;
  }

  // A search-only panel (the home page) stays blank until a query is entered,
  // rather than defaulting to a browse of the whole index the way the
  // /remote-workers/ and cluster pages do.
  var blankUntilSearch = panel.hasAttribute("data-ioc-blank");

  // The home page mounts the panel without a show-more control of its own.
  if (!moreWrap) {
    moreWrap = el("p", "form-hint");
    moreWrap.hidden = true;
    moreButton = el("button", "btn btn--secondary", "Show more results");
    moreButton.type = "button";
    moreWrap.appendChild(moreButton);
    resultsList.parentNode.insertBefore(moreWrap, resultsList.nextSibling);
  }

  var index = null;
  var haystacks = [];
  // The dotless Gmail mailboxes of each record, index-parallel with haystacks,
  // for matching a partial address typed with its dots.
  var mailHaystacks = [];
  var matches = [];
  var shown = 0;
  var activeType = "all";
  var activeCampaign = "all";
  var activeStatus = "all";
  var currentQuery = "";

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * The text a result shows for a record's value. A compromised repository is
   * stored as owner/repo and shown as the full https://github.com/owner/repo
   * address, as plain text: these repositories carry live malware, so nothing
   * here ever makes it a link. Mirrors the iocLabel filter in .eleventy.js.
   */
  function displayValue(record) {
    var value = String(record.v);
    return index.types[record.t] === "compromised_repository" && /^[\w.-]+\/[\w.-]+$/.test(value)
      ? "https://github.com/" + value
      : value;
  }

  /**
   * The earliest publication date among a record's cited sources, the day a
   * public report first named the value, or "" when no source carries one.
   * Mirrors report_date in src/_data/iocIndex.js. Not `f` (first_seen), which
   * falls back to the day a source was read. Worked out once per record.
   */
  function reportDate(record) {
    if (record.rd === undefined) {
      var earliest = "";
      (record.s || []).forEach(function (entry) {
        var source = index.sources[entry[0]];
        var date = source && source.d ? String(source.d).slice(0, 10) : "";
        if (date && (!earliest || date < earliest)) earliest = date;
      });
      record.rd = earliest;
    }
    return record.rd;
  }

  /** How many distinct documents cite the value; source_count in iocIndex.js. */
  function sourceCount(record) {
    var seen = {};
    var count = 0;
    (record.s || []).forEach(function (entry) {
      if (!seen[entry[0]]) {
        seen[entry[0]] = true;
        count += 1;
      }
    });
    return count;
  }

  function typeOf(record) {
    // A record the generator left without a type renders as "indicator"
    // rather than throwing, which would stop every result from rendering.
    return index.types[record.t] || "indicator";
  }

  // The table's columns, in the order of the header in partials/ioc-table.njk.
  // Each sorts the whole result set by its key, ascending on the first press of
  // its header and descending on the second, the way table-sort.js sorts every
  // other table; a record with no value for the column sorts last either way.
  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  var COLUMNS = [
    { key: function (r) { return displayValue(r).toLowerCase(); } },
    { key: function (r) { return typeOf(r).replace(/_/g, " "); } },
    { key: function (r) { return String(r.p || (r.k || [])[0] || "").toLowerCase(); } },
    { key: function (r) { return reportDate(r) || r.rr || r.f || ""; } },
    { key: sourceCount, number: true },
  ];
  var sortColumn = -1;
  var sortDirection = "ascending";
  var headerLabels = [];

  function cell(row, column, className) {
    var td = el("td", className);
    if (headerLabels[column]) td.setAttribute("data-label", headerLabels[column]);
    row.appendChild(td);
    return td;
  }

  function renderResult(record) {
    var type = typeOf(record);
    var method = index.methods[record.e];
    var meta = METHODS[method] || METHODS["bulk-dataset"];

    var tr = el("tr");
    tr.id = record.i;
    tr.setAttribute("data-type", type);

    // The value, with whatever status it carries: the network an IP address
    // is on, LIVE MALWARE or TAKEN DOWN, an account's liveness. Only some
    // types carry each, so most rows show none.
    var value = el("span", "cell-chips");
    var link = el("a");
    // An indicator that belongs to one persona is shown on that persona's page,
    // alongside the accounts, photographs and CV filed under the same identity,
    // and the result goes straight to the anchor for it there. Only a record with
    // no persona, or one two personas share, has a page of its own. `h` carries
    // the slug; see persona_home in src/_data/iocIndex.js.
    link.href = record.h
      ? "/remote-workers/personas/" + record.h + "/#ioc-" + record.i
      : "/indicators/" + record.i + "/";
    link.appendChild(el("code", null, displayValue(record)));
    value.appendChild(link);
    // What kind of network an IP address is on, and the VPN service where one
    // is named. `n` is [kind, label]; see network_status in src/_data/iocIndex.js.
    if (record.n) {
      var anon = record.n[0] === "vpn" || record.n[0] === "proxy";
      value.appendChild(el("span", "tag-chip tag-chip--network" + (anon ? " tag-chip--network-anon" : ""), record.n[1]));
    }
    // Same badge as partials/malware-badge.njk.
    if (record.m) {
      value.appendChild(
        record.m === "live" ? el("span", "badge badge--confirmed", "Live malware") : el("span", "badge badge--low", "Taken down")
      );
    }
    if (record.m && record.mc) value.appendChild(el("span", "ioc-result__meta", "checked " + record.mc));
    // Same badge as partials/account-badge.njk.
    if (record.a && record.a.state) {
      value.appendChild(el("span", "badge badge--" + (record.a.state === "live" ? "high" : "low"), String(record.a.state)));
      if (record.a.checked) value.appendChild(el("span", "ioc-result__meta", "checked " + record.a.checked));
    }
    cell(tr, 0).appendChild(value);

    var typeCell = el("span", "cell-chips", type.replace(/_/g, " ") + " ");
    typeCell.appendChild(el("span", "badge badge--" + meta.badge, meta.label));
    cell(tr, 1).appendChild(typeCell);

    // The persona this indicator was reported under and its activity clusters.
    var who = el("span", "cell-chips");
    if (record.p) who.appendChild(el("span", "tag-chip tag-chip--persona", record.p));
    (record.k || []).forEach(function (campaign) {
      who.appendChild(el("span", "tag-chip", campaign));
    });
    cell(tr, 2).appendChild(who);

    var dateCell = cell(tr, 3, "cell-date");
    if (reportDate(record)) dateCell.textContent = reportDate(record);
    else if (record.rr || record.f) {
      dateCell.textContent = (record.rr || record.f) + " ";
      dateCell.appendChild(el("span", "date-note", record.rk === "linkedin" ? "LinkedIn joined" : record.rk === "github" ? "GitHub created" : "recorded"));
    } else dateCell.textContent = "—";
    cell(tr, 4).textContent = String(sourceCount(record));
    return tr;
  }

  function renderPage(count) {
    var slice = matches.slice(shown, shown + count);
    var fragment = document.createDocumentFragment();
    slice.forEach(function (record) {
      fragment.appendChild(renderResult(record));
    });
    resultsBody.appendChild(fragment);
    shown += slice.length;
    resultsList.hidden = !matches.length;
    // table-stack.js re-measures the table: rows arrived after it last did.
    resultsTable.dispatchEvent(new CustomEvent("tablerender", { bubbles: true }));

    var remaining = matches.length - shown;
    U.hideMore(moreWrap, moreButton, remaining <= 0, countEl);
    if (moreButton && remaining > 0) {
      var next = Math.min(MORE_COUNT, remaining);
      moreButton.textContent =
        "Show " + next.toLocaleString() + " more (" + remaining.toLocaleString() + " remaining)";
    }
  }

  function announce(query) {
    if (!countEl) return;
    if (!matches.length) {
      countEl.textContent = query
        ? 'No indicators match "' + query + '".'
        : "No indicators in the index.";
      return;
    }
    var total = matches.length.toLocaleString();
    var noun = " indicator" + (matches.length === 1 ? "" : "s");
    // Past the first page the line says how much of the match is on screen,
    // so a capped list never reads as the whole result.
    var partial = shown < matches.length ? "Showing " + shown.toLocaleString() + " of " + total + noun : null;
    if (query) {
      countEl.textContent = (partial || total + noun) + ' matching "' + query + '"';
    } else if (activeType !== "all" || activeCampaign !== "all" || activeStatus !== "all") {
      countEl.textContent = (partial || total + noun) + " in this filter. Type to narrow further.";
    } else {
      countEl.textContent = (partial || "Showing all " + total + " indicators") + ". Type to narrow the list.";
    }
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  /**
   * Every whitespace-separated term must appear as a substring somewhere in
   * the record's haystack — its value, display name, persona, activity cluster,
   * every context quote and every source title. Substring rather than prefix
   * matching is what makes a fragment like "gmail" or a phrase from a report
   * find things. The type, cluster and account-status chips each narrow
   * independently of the text and of each other.
   */
  /**
   * How well a record matches, lower first: the query is the value itself,
   * then the value starts with it, then the value contains it, then the
   * display name or persona does, then only a quote or source title does.
   * Without it a pasted IP address came back thirtieth, behind every record
   * whose report quoted it, because the matches kept index order.
   */
  function relevance(record, query, terms) {
    var value = String(record.v).toLowerCase();
    var shown = String(record.d || (displayValue(record) !== record.v ? displayValue(record) : "")).toLowerCase();
    var mailbox = canonicalMailbox(query);
    if (value === query || shown === query || (mailbox && canonicalMailbox(value) === mailbox)) return 0;
    if (value.indexOf(query) === 0 || shown.indexOf(query) === 0) return 1;
    if (value.indexOf(query) !== -1 || shown.indexOf(query) !== -1) return 2;
    var names = (value + " " + shown + " " + String(record.p || "") + " " + String(record.w || "")).toLowerCase();
    for (var t = 0; t < terms.length; t += 1) if (names.indexOf(terms[t]) === -1) return 4;
    return 3;
  }

  /**
   * A column header the reader pressed orders the whole match, not just the
   * rows on screen; until one is pressed a search ranks by relevance() and an
   * empty search keeps index order.
   */
  function sortMatches(query, terms) {
    if (sortColumn !== -1) {
      var column = COLUMNS[sortColumn];
      var descending = sortDirection === "descending";
      var keyed = matches.map(function (record, position) {
        var key = column.key(record);
        return { record: record, position: position, key: key, empty: key === "" || key == null };
      });
      keyed.sort(function (a, b) {
        if (a.empty !== b.empty) return a.empty ? 1 : -1;
        var order = 0;
        if (!a.empty) {
          order = column.number ? a.key - b.key : collator.compare(a.key, b.key);
          if (descending) order = -order;
        }
        return order || a.position - b.position;
      });
      matches = keyed.map(function (item) { return item.record; });
    } else if (terms && terms.length) {
      // Array.prototype.sort is stable, so equal scores keep index order.
      var scores = new Map();
      matches.forEach(function (record) { scores.set(record, relevance(record, query, terms)); });
      matches.sort(function (a, b) { return scores.get(a) - scores.get(b); });
    }
  }

  /**
   * The mailbox a Gmail address reaches: dots and anything after a plus in
   * the local part dropped, googlemail.com folded onto gmail.com. Null for
   * every other host, where a dot is part of the address and two spellings
   * are two people. Mirrors canonicalMailbox() in scripts/lib/ioc-normalize.js,
   * which is how the index stores every Gmail address.
   */
  var DOT_INSENSITIVE_HOSTS = ["gmail.com", "googlemail.com"];
  function canonicalMailbox(address) {
    var at = address.lastIndexOf("@");
    if (at === -1 || DOT_INSENSITIVE_HOSTS.indexOf(address.slice(at + 1)) === -1) return null;
    var mailbox = address.slice(0, at).split("+")[0].replace(/\./g, "");
    return mailbox ? mailbox + "@gmail.com" : null;
  }

  /**
   * A partial Gmail address typed with its dots, such as "meji.oladipo23",
   * never meets the stored mailbox, which Gmail's own rules fold to
   * "mejioladipo23@gmail.com". This is the term with the dots taken out of its
   * local part, compared only against the records' Gmail mailboxes, so an IP
   * address or a domain can never match by losing its dots.
   */
  function dotlessMailboxTerm(term) {
    if (term.indexOf(".") === -1 || !/[a-z]/.test(term) || !/^[a-z0-9._+-]+(@[a-z0-9.-]*)?$/.test(term)) return null;
    var at = term.indexOf("@");
    var local = (at === -1 ? term : term.slice(0, at)).split("+")[0].replace(/\./g, "");
    if (local.length < 3) return null;
    return at === -1 ? local : local + term.slice(at);
  }

  function filter(query, keep) {
    currentQuery = query;
    var terms = U.terms(query);
    var mailboxes = terms.map(canonicalMailbox);
    var dotless = terms.map(dotlessMailboxTerm);
    // The home page mounts the panel with data-ioc-blank: it is a search box,
    // not a browse view, so an empty query shows nothing rather than the whole
    // index. This also keeps it from announcing a total that disagrees with
    // the headline count, which sums areas this search deliberately excludes.
    if (blankUntilSearch && !terms.length && activeType === "all" && activeCampaign === "all" && activeStatus === "all") {
      matches = [];
      resultsBody.textContent = "";
      resultsList.hidden = true;
      shown = 0;
      moreWrap.hidden = true;
      if (countEl) countEl.textContent = "";
      return;
    }
    matches = [];
    for (var i = 0; i < index.records.length; i += 1) {
      var record = index.records[i];
      if (activeType !== "all" && index.types[record.t] !== activeType) continue;
      if (activeCampaign !== "all" && (record.k || []).indexOf(activeCampaign) === -1) continue;
      // An indicator that is not an account has no liveness state, so any
      // status filter excludes it rather than treating "unchecked" as a match.
      if (activeStatus !== "all" && (!record.a || record.a.state !== activeStatus)) continue;
      var haystack = haystacks[i];
      var ok = true;
      for (var t = 0; t < terms.length; t += 1) {
        if (haystack.indexOf(terms[t]) !== -1) continue;
        // A pasted Gmail address matches by mailbox as well as literally: the
        // dotted form somebody was given and the dotted form a report printed
        // are the same account, and buildHaystacks carries the canonical copy
        // this compares against.
        if (mailboxes[t] && haystack.indexOf(mailboxes[t]) !== -1) continue;
        if (dotless[t] && mailHaystacks[i].indexOf(dotless[t]) !== -1) continue;
        ok = false;
        break;
      }
      if (ok) matches.push(record);
    }
    sortMatches(query.trim().toLowerCase(), terms);

    resultsBody.textContent = "";
    shown = 0;
    renderPage(Math.max(INITIAL_COUNT, keep || 0));
    announce(query);
  }

  // The chips are part of the query: a shared or reloaded link restores the
  // filters as well as the text, and the URL says what the list shows.
  var CHIP_PARAMS = { type: "type", campaign: "cluster", status: "status" };

  function applyQuery(query, pushUrl, keep) {
    filter(query, keep);
    if (pushUrl) {
      var params = new URLSearchParams();
      if (query) params.set("q", query);
      if (activeType !== "all") params.set(CHIP_PARAMS.type, activeType);
      if (activeCampaign !== "all") params.set(CHIP_PARAMS.campaign, activeCampaign);
      if (activeStatus !== "all") params.set(CHIP_PARAMS.status, activeStatus);
      var search = params.toString();
      history.replaceState(null, "", location.pathname + (search ? "?" + search : "") + location.hash);
    }
  }

  function pressChip(dimension, value) {
    var found = false;
    Array.prototype.forEach.call(
      panel.querySelectorAll('.filter-chip[data-filter="' + dimension + '"]'),
      function (chip) {
        var pressed = chip.getAttribute("data-value") === value;
        if (pressed) found = true;
        chip.setAttribute("aria-pressed", String(pressed));
      }
    );
    return found;
  }

  function restoreChips(params) {
    var type = params.get(CHIP_PARAMS.type);
    var campaign = params.get(CHIP_PARAMS.campaign);
    var status = params.get(CHIP_PARAMS.status);
    // A value no chip offers is ignored rather than applied, so a stale link
    // cannot pin the list to a filter the reader has no way to clear.
    if (type && pressChip("type", type)) activeType = type;
    if (campaign && pressChip("campaign", campaign)) activeCampaign = campaign;
    if (status && pressChip("status", status)) activeStatus = status;
  }

  var onInput = U.debounce(function () {
    applyQuery(input.value.trim(), true);
  }, DEBOUNCE_MS);

  // -------------------------------------------------------------------------
  // Export / download
  // -------------------------------------------------------------------------
  //
  // Exports whatever `matches` currently holds — the live result of the
  // search text and filter chips above — optionally narrowed further by the
  // download panel's own type <select>, which is independent of the type
  // filter chip so a reader can pull one type out of a broader search without
  // losing it. Four formats, all built client-side from the same compact
  // records already in memory: no second fetch, no server.

  /**
   * Single-quotes and backslashes are the two characters a STIX pattern
   * string has to escape; everything else in a value (unicode, spaces,
   * punctuation) is passed through as-is.
   */
  function escapePatternValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function hashAlgorithm(value) {
    if (!/^[0-9a-fA-F]+$/.test(value)) return null;
    if (value.length === 32) return "MD5";
    if (value.length === 40) return "SHA-1";
    if (value.length === 64) return "SHA-256";
    if (value.length === 128) return "SHA-512";
    return null;
  }

  /**
   * A dataset entry is stored `name@version` (scoped packages keep their own
   * leading `@`, e.g. `@kolbo/mcp@1.57.1` — see CONTENT_GUIDE.md), so the
   * version is whatever follows the LAST `@` provided it isn't the scope's
   * own leading character.
   */
  function splitPackageVersion(value) {
    var at = value.lastIndexOf("@");
    if (at <= 0) return { name: value, version: null };
    return { name: value.slice(0, at), version: value.slice(at + 1) };
  }

  /**
   * One STIX pattern per ioc_type. Where the type has a clean built-in STIX
   * 2.1 cyber-observable, that observable is used directly.
   *
   * Every account/profile type not handled above — github_profile,
   * linkedin_profile, telegram_account, the growing list of *_account types
   * in PLATFORM_ACCOUNTS (scripts/lib/ioc-normalize.js) — stores its value as
   * a canonical profile URL (CONTENT_GUIDE.md), so rather than naming each
   * type here, ANY value shaped like one maps onto STIX's `url` observable.
   * That covers a new *_account type the moment its data lands, with nothing
   * to update in this file. `personal_site` gets the same pattern even for
   * the handful of values recorded without a scheme, since the type itself
   * says what it is.
   *
   * Everything left over — a wallet address, a transaction hash, a Skype
   * handle, a bare username or alias, a phone number, `other` — has no
   * built-in STIX observable of its own, so all of it shares one fallback
   * pattern, `user-account:account_login`, with the real ioc_type preserved
   * on the indicator as `x_chollimahunter_ioc_type` (see buildIndicator)
   * rather than guessed back out of the pattern.
   */
  function stixPattern(record) {
    var v = escapePatternValue(record.value);
    var type = record.ioc_type;
    if (type === "email_address") return "[email-addr:value = '" + v + "']";
    if (type === "ip_address") {
      var isV6 = record.value.indexOf(":") !== -1;
      return "[" + (isV6 ? "ipv6-addr" : "ipv4-addr") + ":value = '" + v + "']";
    }
    if (type === "domain" || type === "hosted_site") return "[domain-name:value = '" + v + "']";
    if (type === "filename") return "[file:name = '" + v + "']";
    // A hash of no recognised length names no algorithm STIX accepts, so it
    // takes the shared fallback below rather than an invented hash key.
    var algo = type === "file_hash" ? hashAlgorithm(record.value) : null;
    if (algo) return "[file:hashes.'" + algo + "' = '" + v + "']";
    if (type === "npm_package" || type === "pypi_package") {
      var parts = splitPackageVersion(record.value);
      var pattern = "software:name = '" + escapePatternValue(parts.name) + "'";
      if (parts.version) pattern += " AND software:version = '" + escapePatternValue(parts.version) + "'";
      return "[" + pattern + "]";
    }
    if (type === "asn") {
      var digits = record.value.replace(/[^0-9]/g, "");
      return digits ? "[autonomous-system:number = " + digits + "]" : "[autonomous-system:name = '" + v + "']";
    }
    if (type === "payload_url" || type === "personal_site" || /^https?:\/\//i.test(record.value)) return "[url:value = '" + v + "']";
    return "[user-account:account_login = '" + v + "']";
  }

  /** Compact-record fields (see compactIndex() in src/_data/iocIndex.js) resolved to plain values for every export format. */
  function resolveRecord(record) {
    var sources = (record.s || []).map(function (entry) {
      var source = index.sources[entry[0]] || {};
      var context = (index.contexts && index.contexts[entry[1]]) || "";
      return {
        url: source.u || null,
        title: source.t || null,
        publisher: source.p || null,
        published: source.d || null,
        context: context,
        pulled_at: entry[2] || null,
      };
    });
    return {
      id: record.i,
      ioc_type: index.types[record.t],
      value: record.v,
      display: record.d || null,
      persona: record.p || null,
      campaigns: record.k || [],
      first_seen: record.f || null,
      last_seen: record.l || null,
      account_status: record.a || null,
      malware_status: record.m || null,
      network: record.n ? { kind: record.n[0], label: record.n[1] } : null,
      sources: sources,
    };
  }

  function recordsToCsv(records) {
    var rows = [
      ["value", "ioc_type", "display", "persona", "campaigns", "first_seen", "last_seen", "network",
       "source_urls", "source_titles", "context"].join(","),
    ];
    records.forEach(function (r) {
      rows.push([
        r.value, r.ioc_type, r.display || "", r.persona || "", r.campaigns.join("; "),
        r.first_seen || "", r.last_seen || "", r.network ? r.network.label : "",
        r.sources.map(function (s) { return s.url; }).filter(Boolean).join(" | "),
        r.sources.map(function (s) { return s.title; }).filter(Boolean).join(" | "),
        r.sources.map(function (s) { return s.context; }).filter(Boolean).join(" | "),
      ].map(U.csvCell).join(","));
    });
    return rows.join("\n");
  }

  function recordsToText(records) {
    return records.map(function (r) { return r.value; }).join("\n") + "\n";
  }

  function fallbackUuidV4() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return bytesToUuid(bytes);
  }

  function bytesToUuid(bytes) {
    var hex = Array.prototype.map
      .call(bytes, function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
    return hex.substr(0, 8) + "-" + hex.substr(8, 4) + "-" + hex.substr(12, 4) + "-" +
      hex.substr(16, 4) + "-" + hex.substr(20, 12);
  }

  /**
   * A deterministic UUIDv5 (RFC 4122) from `name` under STIX_NAMESPACE, via
   * SubtleCrypto's SHA-1 — available in every browser this site otherwise
   * supports over https (and over http on localhost, where the dev server
   * runs). Re-downloading the same indicator produces the same id, which is
   * the point: two exports of the same record diff cleanly. Falls back to a
   * random id, which loses that property, only where SubtleCrypto itself is
   * unavailable.
   */
  function uuidv5(name, namespaceUuid) {
    if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest)) {
      return Promise.resolve(fallbackUuidV4());
    }
    var nsHex = namespaceUuid.replace(/-/g, "");
    var nsBytes = new Uint8Array(16);
    for (var i = 0; i < 16; i += 1) nsBytes[i] = parseInt(nsHex.substr(i * 2, 2), 16);
    var nameBytes = new TextEncoder().encode(name);
    var data = new Uint8Array(nsBytes.length + nameBytes.length);
    data.set(nsBytes, 0);
    data.set(nameBytes, nsBytes.length);
    return window.crypto.subtle.digest("SHA-1", data).then(function (digest) {
      var bytes = new Uint8Array(digest).slice(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
      return bytesToUuid(bytes);
    }).catch(function () {
      return fallbackUuidV4();
    });
  }

  function buildIndicator(record, id, createdByRef, timestamp) {
    var description = record.sources.map(function (s) { return s.context; }).filter(Boolean).join(" ");
    var indicator = {
      type: "indicator",
      spec_version: "2.1",
      id: "indicator--" + id,
      created: timestamp,
      modified: timestamp,
      created_by_ref: createdByRef,
      name: record.display || record.value,
      pattern: stixPattern(record),
      pattern_type: "stix",
      valid_from: record.first_seen ? record.first_seen + "T00:00:00.000Z" : timestamp,
      // STIX 2.1 replaced Indicator's `labels` with the open-vocab
      // `indicator_types`; both are set so a 2.0-era consumer and a 2.1 one
      // each find what they expect. Neither vocabulary has a term for "a
      // reported operator identifier", so the DPRK activity clusters this
      // record is tagged with stand in for it, same as the tag-chips beside
      // the result on the site itself.
      labels: record.campaigns.length ? record.campaigns.slice() : ["dprk-indicator"],
      indicator_types: ["anomalous-activity"],
      object_marking_refs: [TLP_WHITE_ID],
      x_chollimahunter_ioc_type: record.ioc_type,
      x_chollimahunter_id: record.id,
    };
    if (description) indicator.description = description;
    if (record.persona) indicator.x_chollimahunter_persona = record.persona;
    var externalReferences = record.sources
      .filter(function (s) { return s.url; })
      .map(function (s) {
        var ref = { source_name: s.publisher || s.title || "source", url: s.url };
        if (s.title) ref.description = s.title;
        return ref;
      });
    if (externalReferences.length) indicator.external_references = externalReferences;
    return indicator;
  }

  /** Every value rendered here originates from a scraped third-party page, same as the search results themselves — see the file header. */
  function buildStixBundle(records) {
    var timestamp = new Date().toISOString().replace(/\.\d\d\d\d+Z$/, ".000Z");
    return uuidv5("Chollima Hunter", STIX_NAMESPACE).then(function (identityId) {
      var identity = {
        type: "identity",
        spec_version: "2.1",
        id: "identity--" + identityId,
        created: timestamp,
        modified: timestamp,
        name: "Chollima Hunter",
        identity_class: "organization",
        description: "Tracks, documents and exposes DPRK state-sponsored cyber campaigns, actors and infrastructure. Every indicator in this bundle cites the public source it was drawn from.",
      };
      return Promise.all(
        records.map(function (record) {
          return uuidv5(record.ioc_type + ":" + record.value, STIX_NAMESPACE).then(function (id) {
            return buildIndicator(record, id, identity.id, timestamp);
          });
        })
      ).then(function (indicators) {
        var bundleId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : fallbackUuidV4();
        return {
          type: "bundle",
          id: "bundle--" + bundleId,
          objects: [identity, TLP_WHITE_OBJECT].concat(indicators),
        };
      });
    });
  }

  /*
    MISP event export. MISP is the open threat-sharing platform most CTI teams
    run, and it imports this shape directly (Event > Attribute). Each record
    becomes one attribute typed from MISP's own vocabulary; a value MISP has
    no type for goes in as text rather than being forced into a wrong one.
    to_ids marks what a detection tool can match on the wire or on disk, not
    identity values an analyst pivots on. The sources go in the comment and
    the DPRK activity clusters as tags, so the provenance travels with each
    attribute.
  */
  function mispAttributeType(record) {
    var v = record.value;
    switch (record.ioc_type) {
      case "email_address": return ["email", "Social network", false];
      case "ip_address": return ["ip-dst", "Network activity", true];
      case "domain": return ["domain", "Network activity", true];
      case "hosted_site": return ["hostname", "Network activity", true];
      case "payload_url": return ["url", "Payload delivery", true];
      case "asn": return ["AS", "Network activity", false];
      case "filename": return ["filename", "Payload delivery", false];
      case "chrome_extension": return ["chrome-extension-id", "Payload delivery", true];
      case "phone_number": return ["phone-number", "Other", false];
      case "file_hash":
        if (/^[a-f0-9]{32}$/i.test(v)) return ["md5", "Payload delivery", true];
        if (/^[a-f0-9]{40}$/i.test(v)) return ["sha1", "Payload delivery", true];
        if (/^[a-f0-9]{64}$/i.test(v)) return ["sha256", "Payload delivery", true];
        return ["text", "Payload delivery", false];
      case "wallet_address":
        if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(v)) return ["btc", "Financial fraud", false];
        if (/^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(v)) return ["xmr", "Financial fraud", false];
        return ["text", "Financial fraud", false];
      case "github_profile": return ["github-username", "Social network", false];
      case "malicious_repository":
      case "compromised_repository":
        return /^https?:/.test(v) || /^(gitlab|bitbucket)\./.test(v)
          ? ["url", "Payload delivery", false]
          : ["github-repository", "Payload delivery", false];
      default:
        return /^https?:\/\//.test(v) ? ["url", "Social network", false] : ["text", "Other", false];
    }
  }

  function mispValue(record, type) {
    if (type === "github-username") return record.value.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\/+$/, "");
    return record.value;
  }

  function buildMispEvent(records) {
    var now = new Date();
    var uuid = function () {
      return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : fallbackUuidV4();
    };
    var attributes = records.map(function (record) {
      var t = mispAttributeType(record);
      var comment = record.ioc_type.replace(/_/g, " ") +
        (record.persona ? " — persona " + record.persona : "") +
        (record.sources.length
          ? ". Sources: " + record.sources.map(function (s) { return s.url || s.title; }).filter(Boolean).join(" ")
          : "");
      var attribute = {
        uuid: uuid(),
        type: t[0],
        category: t[1],
        value: mispValue(record, t[0]),
        to_ids: t[2],
        comment: comment,
        Tag: record.campaigns.map(function (c) { return { name: "chollimahunter:cluster=\"" + c + "\"" }; }),
      };
      if (record.first_seen) attribute.first_seen = record.first_seen + "T00:00:00Z";
      if (record.last_seen) attribute.last_seen = record.last_seen + "T00:00:00Z";
      return attribute;
    });
    return {
      Event: {
        uuid: uuid(),
        info: "Chollima Hunter DPRK indicators export (" + records.length + " indicators)",
        date: now.toISOString().slice(0, 10),
        timestamp: String(Math.floor(now.getTime() / 1000)),
        threat_level_id: "2",
        analysis: "2",
        distribution: "3",
        published: false,
        Orgc: { name: "Chollima Hunter" },
        Tag: [{ name: "tlp:clear" }],
        Attribute: attributes,
      },
    };
  }

  function runDownload() {
    if (!index || downloadWaiting) return;
    var format = downloadFormat ? downloadFormat.value : "stix";
    // CSV, JSON and STIX carry the context quotes, which arrive after the
    // core index; a file taken before they land would have them blank.
    var usesContexts = format !== "txt" && format !== "misp";
    if (usesContexts && contextsState === "pending" && contextsWait) {
      downloadWaiting = true;
      if (downloadStatus) downloadStatus.textContent = "Waiting for the context quotes to finish loading\u2026";
      contextsWait.then(function () {
        downloadWaiting = false;
        runDownload();
      });
      return;
    }
    var subset = matches;
    if (!subset.length) {
      if (downloadStatus) {
        downloadStatus.textContent = "Nothing to download: no indicators match the current search.";
      }
      return;
    }

    var resolved = subset.map(resolveRecord);
    var datestamp = new Date().toISOString().slice(0, 10);
    var baseName = "chollima-iocs-" + (activeType !== "all" ? activeType : "filtered") + "-" + datestamp;
    var count = resolved.length;
    var noun = count.toLocaleString() + " indicator" + (count === 1 ? "" : "s");
    var caveat = usesContexts && contextsState === "failed"
      ? " The context quotes could not be loaded, so the file has none."
      : "";

    if (format === "csv") {
      U.downloadBlob(recordsToCsv(resolved), baseName + ".csv", "text/csv");
      if (downloadStatus) downloadStatus.textContent = "Downloaded " + noun + " as CSV." + caveat;
    } else if (format === "txt") {
      U.downloadBlob(recordsToText(resolved), baseName + ".txt", "text/plain");
      if (downloadStatus) downloadStatus.textContent = "Downloaded " + noun + " as plain text.";
    } else if (format === "misp") {
      U.downloadBlob(JSON.stringify(buildMispEvent(resolved), null, 2), baseName + ".misp.json", "application/json");
      if (downloadStatus) downloadStatus.textContent = "Downloaded " + noun + " as a MISP event.";
    } else if (format === "json") {
      U.downloadBlob(JSON.stringify(resolved, null, 2), baseName + ".json", "application/json");
      if (downloadStatus) downloadStatus.textContent = "Downloaded " + noun + " as JSON." + caveat;
    } else {
      if (downloadStatus) downloadStatus.textContent = "Building a STIX bundle for " + noun + "…";
      buildStixBundle(resolved).then(function (bundle) {
        U.downloadBlob(JSON.stringify(bundle, null, 2), baseName + ".stix.json", "application/json");
        if (downloadStatus) downloadStatus.textContent = "Downloaded " + noun + " as a STIX 2.1 bundle." + caveat;
      }).catch(function (err) {
        if (downloadStatus) downloadStatus.textContent = "Could not build the STIX bundle (" + err.message + ").";
      });
    }
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  function buildHaystacks() {
    mailHaystacks = index.records.map(function (record) {
      return [record.v, record.d].map(function (value) {
        return value ? canonicalMailbox(String(value).toLowerCase()) : null;
      }).filter(Boolean).join(" ");
    });
    haystacks = index.records.map(function (record) {
      var parts = [displayValue(record), record.v, record.d || "", record.p || "", record.w || ""].concat(record.k || []).concat(record.n || []);
      // A Gmail address is stored as the mailbox it reaches, because Gmail
      // ignores dots, but a reader pastes whatever form they were given, and it
      // may be dotted differently from anything this index has seen. Carrying
      // the canonical copy lets the query below match any of them.
      var mailbox = canonicalMailbox(String(record.v).toLowerCase());
      if (mailbox) parts.push(mailbox);
      var shownMailbox = record.d ? canonicalMailbox(String(record.d).toLowerCase()) : null;
      if (shownMailbox) parts.push(shownMailbox);
      record.s.forEach(function (entry) {
        // v2 of the payload stores an index into index.contexts here rather
        // than the quote itself; see compactIndex() in src/_data/iocIndex.js.
        parts.push(index.contexts[entry[1]] || "");
        var source = index.sources[entry[0]];
        if (source) parts.push(source.t || "", source.p || "");
      });
      return parts.join(" ").toLowerCase();
    });
  }

  /**
   * Drop every record outside this page's cluster before anything else reads
   * the index. haystacks[] is built index-parallel, so the records have to be
   * narrowed first — filtering later would misalign the two.
   */
  function applyScope(loaded) {
    // The shared index carries more than one area (remote-worker identities and
    // the espionage indicators split off from them). A page marked with an area
    // sees only its own; /remote-workers/ uses this to drop the espionage
    // records the cluster pages still search.
    // data-ioc-area is a space-separated list; /remote-workers/ names both its
    // own area and polinrider (the compromised-repository list). A page with no
    // area, the cluster pages and the home page, drops polinrider records, which
    // the index carries only for the pages that ask for them.
    var area = panel.getAttribute("data-ioc-area");
    var areas = area ? area.split(/\s+/).filter(Boolean) : null;
    loaded.records = loaded.records.filter(function (record) {
      var recordArea = record.r || "remote-workers";
      return areas ? areas.indexOf(recordArea) !== -1 : recordArea !== "polinrider" || !!ownIndex;
    });
    var raw = panel.getAttribute("data-ioc-scope");
    if (!raw) return loaded;
    var wanted = raw.split("|").map(function (label) {
      return label.trim();
    }).filter(Boolean);
    if (!wanted.length) return loaded;
    loaded.records = loaded.records.filter(function (record) {
      var campaigns = record.k || [];
      for (var i = 0; i < campaigns.length; i += 1) {
        if (wanted.indexOf(campaigns[i]) !== -1) return true;
      }
      return false;
    });
    return loaded;
  }

  /**
   * The results table's column headers become sort buttons with the markup
   * and aria-sort states table-sort.js gives every other table, so the two
   * look and read the same; the table carries data-no-sort so table-sort.js,
   * which could only reorder the rendered rows, leaves it to this. A press
   * re-sorts every match and renders the first page again, keeping as many
   * rows open as the reader had.
   */
  function wireHeaders() {
    var head = resultsTable.tHead && resultsTable.tHead.rows[0];
    if (!head) return;
    var cells = Array.prototype.slice.call(head.cells);
    headerLabels = cells.map(function (th) {
      return th.textContent.replace(/\s+/g, " ").trim();
    });
    cells.forEach(function (th, column) {
      if (!COLUMNS[column]) return;
      var button = el("button", "table-sort__button");
      button.type = "button";
      while (th.firstChild) button.appendChild(th.firstChild);
      th.appendChild(button);
      th.setAttribute("aria-sort", "none");
      button.addEventListener("click", function () {
        sortDirection = sortColumn === column && sortDirection === "ascending" ? "descending" : "ascending";
        sortColumn = column;
        cells.forEach(function (other) {
          if (other.hasAttribute("aria-sort")) other.setAttribute("aria-sort", "none");
        });
        th.setAttribute("aria-sort", sortDirection);
        applyQuery(input.value.trim(), false, shown);
      });
    });
  }

  function start(loaded) {
    index = applyScope(loaded);
    // The core file carries no quotes; the table is filled in by loadContexts.
    index.contexts = index.contexts || [];
    buildHaystacks();

    if (fallbackList) fallbackList.hidden = true;
    resultsList.hidden = false;
    panel.hidden = false;

    input.addEventListener("input", onInput);
    wireHeaders();
    if (moreButton) {
      moreButton.addEventListener("click", function () {
        renderPage(MORE_COUNT);
        announce(currentQuery);
      });
    }
    if (downloadButton) {
      downloadButton.addEventListener("click", runDownload);
    }

    Array.prototype.forEach.call(panel.querySelectorAll(".filter-chip[data-filter]"), function (chip) {
      chip.addEventListener("click", function () {
        var dimension = chip.getAttribute("data-filter");
        var value = chip.getAttribute("data-value");
        if (dimension === "campaign") activeCampaign = value;
        else if (dimension === "status") activeStatus = value;
        else activeType = value;
        // Only the chips in this chip's own group change pressed state, so the
        // type and cluster filters stay independent of each other.
        pressChip(dimension, value);
        applyQuery(input.value.trim(), true);
      });
    });
    chipsWired = true;

    // A deferred panel shows its input before the index exists, so by the
    // time this runs the reader may already have typed. What they typed wins
    // over the URL, which would otherwise wipe the box mid-keystroke.
    var params = new URLSearchParams(location.search);
    restoreChips(params);
    var initial = input.value || params.get("q") || "";
    input.value = initial;
    applyQuery(initial.trim(), false);
  }

  function fetchJson(url) {
    return fetch(versioned(url), { credentials: "omit" }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  // The quotes join an index that is already being searched. Once they land
  // the haystacks are rebuilt and whatever the reader has typed is run again,
  // so a phrase that matched nothing a moment ago finds its report, keeping
  // as many rows on screen as the reader had already opened. A failure here
  // is not fatal: values and names still match, and only a download, which
  // would carry the quotes, says they are missing.
  var contextsState = CONTEXTS_URL ? "pending" : "loaded";
  var contextsWait = null;
  var downloadWaiting = false;
  function loadContexts() {
    if (!CONTEXTS_URL) return Promise.resolve();
    contextsWait = fetchJson(CONTEXTS_URL)
      .then(function (loaded) {
        if (!loaded || !loaded.contexts) throw new Error("no context quotes in the file");
        index.contexts = loaded.contexts;
        buildHaystacks();
        contextsState = "loaded";
        if (input.value.trim()) applyQuery(input.value.trim(), false, shown);
      })
      .catch(function () {
        contextsState = "failed";
      });
    return contextsWait;
  }

  // Chips clicked on a deferred panel before start() has wired them, one per
  // filter dimension, latest click winning. The chips are visible from first
  // paint and the index takes a moment to arrive, so every such click is kept
  // and replayed once the handlers exist, or it is silently dropped. The
  // results table's sort headers need no such queue: the table stays hidden
  // until start() has made them buttons.
  var chipsWired = false;
  var pendingChips = {};
  function replayPendingChips() {
    var queued = pendingChips;
    pendingChips = {};
    Object.keys(queued).forEach(function (dimension) {
      queued[dimension].click();
    });
  }

  function load() {
    return fetchJson(CORE_URL)
    .then(start)
    .then(replayPendingChips)
    .then(loadContexts)
    .catch(function (err) {
      // Leave the build-time fallback list in place rather than replacing a
      // working page with an empty one, and say why search isn't available.
      if (countEl) {
        countEl.hidden = false;
        countEl.textContent =
          "The searchable index could not be loaded (" +
          err.message +
          "). " +
          (fallbackList ? "The most recent indicators are listed below; the full" : "The full") +
          " index is at " +
          INDEX_URL +
          ".";
        panel.hidden = false;
        var field = input.closest(".form-field");
        if (field) field.hidden = true;
      }
    });
  }

  // The index is several megabytes, which is the right trade on a page whose
  // whole purpose is searching it and the wrong one on the home page, where
  // most visitors read the prose and leave. A panel marked data-ioc-defer
  // shows its input straight away and fetches on the first focus or keystroke,
  // so the cost falls only on a reader who actually searches.
  if (panel.hasAttribute("data-ioc-defer")) {
    panel.hidden = false;
    var started = false;
    var kickOff = function () {
      if (started) return;
      started = true;
      if (countEl) {
        countEl.hidden = false;
        countEl.textContent = "Loading the index\u2026";
      }
      load();
    };
    input.addEventListener("focus", kickOff, { once: true });
    input.addEventListener("input", kickOff, { once: true });
    panel.addEventListener(
      "click",
      function (event) {
        var chip = event.target.closest ? event.target.closest(".filter-chip[data-filter]") : null;
        if (!chip || chipsWired) return;
        var dimension = chip.getAttribute("data-filter");
        pendingChips[dimension] = chip;
        pressChip(dimension, chip.getAttribute("data-value"));
        kickOff();
      },
      true
    );
    // A shared link carrying a query should still search without being touched.
    if (new URLSearchParams(location.search).get("q")) kickOff();
  } else {
    load();
  }
})();
