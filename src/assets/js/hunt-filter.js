/*
  hunt-filter.js — client-side filtering for the DPRK Hunting library
  ===================================================================

  Progressive enhancement over src/hunts/index.njk. Every hunt tile is
  rendered server-side and is fully readable with this script absent; all this
  adds is the ability to narrow a grid of several dozen tiles by hunt type, by
  the operating system or log plane it covers, or by query language, and to
  reorder what's left by hunt type or query language.

  Contract with the markup (partials/hunt-card.njk):
    - each tile's <li> carries data-hunt-type; data-os, the hunt's `platforms`
      (Windows, macOS, Linux, Identity / cloud, Network) separated by "|"; a
      comma-separated data-platforms, the technologies of the hunt's queries
      (Defender / Sentinel KQL, Splunk SPL, Sigma, ...); and a pre-lowercased
      data-search blob covering the tile's own text plus the hunt's indicator
      table
    - the search box is [data-hunt-search] wrapping [data-hunt-search-input],
      and like the bar it carries `hidden` in the markup and is revealed here
    - the filter bar is [data-hunt-filter], its buttons are the .filter-chip
      rows partials/filter-chips.njk renders, with data-filter ("type", "os"
      or "platform") and data-value
    - a value of "all" within a group clears that group
    - the sort control is [data-hunt-sort], a <select> whose values are
      "default" (library order), "type" or "platform"
    - the bar carries `hidden` in the markup and is revealed here, so a reader
      without JavaScript gets the full grid rather than dead controls

  Sorting reorders the tiles in the DOM (grid.appendChild on an existing node
  moves it rather than duplicating it); filtering only ever toggles `hidden`.
  The two compose because they act on different things: sort decides what
  order the tiles sit in, filter decides which of them show. Array.prototype
  .sort is stable in every browser this site supports, so hunts sharing a sort
  key keep their library order (the sort's own default) rather than shuffling.

  The count element is [data-hunt-count]; it is rewritten as tiles hide so the
  page never claims a total that does not match what is on screen.
*/
(function () {
  "use strict";

  var U = window.siteUtils;
  var DEBOUNCE_MS = 120;

  var bar = document.querySelector("[data-hunt-filter]");
  var grid = document.querySelector("[data-hunt-grid]");
  if (!bar || !grid) return;

  // Revealed only now that the behaviour behind it exists. See the comment in
  // src/hunts/index.njk.
  bar.hidden = false;

  var tiles = Array.prototype.slice.call(grid.children);
  var libraryOrder = tiles.slice();
  var sortSelect = bar.querySelector("[data-hunt-sort]");
  var countEl = document.querySelector("[data-hunt-count]");
  var emptyEl = document.querySelector("[data-hunt-empty]");
  var searchBox = document.querySelector("[data-hunt-search]");
  var searchInput = document.querySelector("[data-hunt-search-input]");
  var state = { type: "all", os: "all", platform: "all", sort: "default", terms: [] };

  if (searchBox) searchBox.hidden = false;

  var sortKeys = {
    type: function (tile) {
      return (tile.getAttribute("data-hunt-type") || "").toLowerCase();
    },
    // A tile can carry more than one query platform; the first one listed
    // (the order hunt-card.njk writes them in) stands in for the tile.
    platform: function (tile) {
      return (tile.getAttribute("data-platforms") || "").split(",")[0].toLowerCase();
    }
  };

  function reorder() {
    var ordered = libraryOrder;
    if (state.sort === "default" && state.terms.length && typeof window.resultRank === "function") {
      // Best match: the hunts whose title best matches the query first, then
      // library order (window.resultRank in result-tools.js).
      var query = state.terms.join(" ");
      var scores = new Map();
      libraryOrder.forEach(function (tile) {
        var title = window.resultTitleOf ? window.resultTitleOf(tile) : tile.textContent;
        scores.set(tile, window.resultRank(query, [title]));
      });
      ordered = libraryOrder.slice().sort(function (a, b) { return scores.get(a) - scores.get(b); });
    } else if (state.sort === "type" || state.sort === "platform") {
      var key = sortKeys[state.sort];
      ordered = libraryOrder.slice().sort(function (a, b) {
        var ak = key(a);
        var bk = key(b);
        if (ak < bk) return -1;
        if (ak > bk) return 1;
        return 0;
      });
    }
    ordered.forEach(function (tile) {
      grid.appendChild(tile);
    });
  }

  function matches(tile) {
    if (state.type !== "all" && tile.getAttribute("data-hunt-type") !== state.type) {
      return false;
    }
    if (state.os !== "all") {
      var os = (tile.getAttribute("data-os") || "").split("|");
      if (os.indexOf(state.os) === -1) return false;
    }
    if (state.platform !== "all") {
      var platforms = (tile.getAttribute("data-platforms") || "").split(",");
      if (platforms.indexOf(state.platform) === -1) return false;
    }
    // Every whitespace-separated term has to appear somewhere in the blob, so
    // "kvm usb" narrows rather than widens. The blob is written lowercased by
    // the template and the terms are lowercased on input, so neither side
    // needs casing work here.
    return U.hasAll(tile.getAttribute("data-search") || "", state.terms);
  }

  function apply() {
    var shown = 0;
    tiles.forEach(function (tile) {
      var visible = matches(tile);
      tile.hidden = !visible;
      if (visible) shown += 1;
    });

    if (countEl) {
      countEl.textContent =
        shown === tiles.length
          ? tiles.length + " hunts."
          : shown + " of " + tiles.length + " hunts.";
    }
    if (emptyEl) emptyEl.hidden = shown !== 0;
  }

  bar.addEventListener("click", function (event) {
    var chip = event.target.closest(".filter-chip");
    if (!chip || !bar.contains(chip)) return;

    var group = chip.getAttribute("data-filter");
    var value = chip.getAttribute("data-value");
    if (!group) return;

    // Clicking the pressed chip again clears that group rather than doing
    // nothing, so a filter can always be undone from the chip that set it.
    state[group] = state[group] === value ? "all" : value;

    bar
      .querySelectorAll('.filter-chip[data-filter="' + group + '"]')
      .forEach(function (other) {
        other.setAttribute(
          "aria-pressed",
          other.getAttribute("data-value") === state[group] ? "true" : "false"
        );
      });

    apply();
  });

  if (searchInput) {
    searchInput.addEventListener("input", U.debounce(function () {
      state.terms = U.terms(searchInput.value);
      reorder();
      apply();
    }, DEBOUNCE_MS));
  }

  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      state.sort = sortSelect.value;
      reorder();
      apply();
    });
  }

  apply();
})();
