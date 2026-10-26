/*
  persona-filter.js — client-side search for the persona listing
  ===================================================================

  Progressive enhancement over src/remote-workers/personas/index.njk. Every
  card is rendered server-side and the page is fully readable with this script
  absent; all this adds is the ability to narrow 160-odd cards to the one being
  looked for.

  The useful query on this page is usually an identifier rather than a name —
  someone arrives holding an address, a GitHub handle or a LinkedIn URL and
  wants the persona it belongs to. So the blob each card carries in
  data-search (built in partials/persona-card.njk) covers the persona's whole
  indicator list, not just the text the card displays.

  Contract with the markup:
    - each card's <li> carries a pre-lowercased data-search
    - the search box is [data-persona-search] wrapping
      [data-persona-search-input], carrying `hidden` in the markup and
      revealed here so a reader without JavaScript never sees a dead control
    - each grid is [data-persona-grid], inside a [data-persona-section]
    - the count is [data-persona-count], the empty state [data-persona-empty]
    - [data-persona-search] may carry data-persona-limit; only that many
      matching cards show until the reader presses [data-persona-more-button]
      inside [data-persona-more], which is `hidden` in the markup for the same
      reason as the search box

  The limit exists because 160-odd cards is a wall a reader scrolls past
  rather than reads. The cap resets to the first page on every new search, so
  a query always shows its best matches first, and pressing the button shows
  everything that matches at once rather than paging.

  A section whose cards are all hidden is hidden with them. The listing has
  one, holding the personas and then the photographs published without an
  identifier; a search that matches nothing leaves the empty-state line in
  its place rather than an empty section.
*/
(function () {
  "use strict";

  var U = window.siteUtils;
  var DEBOUNCE_MS = 120;

  var box = document.querySelector("[data-persona-search]");
  var input = document.querySelector("[data-persona-search-input]");
  var grids = Array.prototype.slice.call(document.querySelectorAll("[data-persona-grid]"));
  if (!box || !input || !grids.length) return;

  // Revealed only now that the behaviour behind it exists.
  box.hidden = false;

  var cards = [];
  function readCards() {
    cards = [];
    grids.forEach(function (grid) {
      Array.prototype.slice.call(grid.children).forEach(function (card) {
        cards.push(card);
      });
    });
  }
  readCards();
  // The Sort dropdown (result-tools.js) reorders the cards in place; the cap
  // below shows the first matches in this list's order, so re-read it.
  grids.forEach(function (grid) {
    grid.addEventListener("resultsort", function () {
      readCards();
      apply();
    });
  });

  // Photographs published with no identifier share the grid but are not
  // personas, so they are counted apart wherever the wording says "persona".
  var photographs = cards.filter(function (card) {
    return card.hasAttribute("data-photograph");
  }).length;
  var personaTotal = cards.length - photographs;

  var countEl = document.querySelector("[data-persona-count]");
  var emptyEl = document.querySelector("[data-persona-empty]");
  var sections = Array.prototype.slice.call(
    document.querySelectorAll("[data-persona-section]")
  );
  var total = cards.length;
  var terms = [];
  var limit = parseInt(box.getAttribute("data-persona-limit"), 10) || 0;
  var moreEl = document.querySelector("[data-persona-more]");
  var moreButton = document.querySelector("[data-persona-more-button]");
  var expanded = false;

  function matches(card) {
    return U.hasAll(card.getAttribute("data-search") || "", terms);
  }

  // Best match: while a query is typed and no title sort is chosen, each grid
  // puts the cards whose name best matches it first (window.resultRank in
  // result-tools.js); cleared, the cards go back to page order.
  cards.forEach(function (card, i) { card.personaFilterOrder = i; });
  var ranked = false;
  function rank() {
    if (typeof window.resultRank !== "function") return;
    var query = terms.join(" ");
    if (!query && !ranked) return;
    grids.forEach(function (grid) {
      var sorted = grid.getAttribute("data-result-sorted");
      if (sorted && sorted !== "default") return;
      var list = Array.prototype.slice.call(grid.children).map(function (card) {
        var title = window.resultTitleOf ? window.resultTitleOf(card) : card.textContent;
        return { card: card, score: query ? window.resultRank(query, [title]) : 0 };
      });
      list.sort(function (a, b) {
        return a.score - b.score || (a.card.personaFilterOrder || 0) - (b.card.personaFilterOrder || 0);
      });
      list.forEach(function (item) { grid.appendChild(item.card); });
    });
    ranked = Boolean(query);
    readCards();
  }

  function apply() {
    rank();
    var matched = 0;
    var shown = 0;
    var inGrid = 0;
    var currentGrid = null;
    var columns = 1;
    cards.forEach(function (card) {
      if (card.parentNode !== currentGrid) {
        currentGrid = card.parentNode;
        columns = U.columnsOf(currentGrid);
        inGrid = 0;
      }
      var hit = matches(card);
      card.personaFilterMatch = hit;
      if (hit) matched += 1;
      // Past the limit, a card is still shown while it completes the row the
      // limit fell in, so the listing never ends on a half-empty row.
      var visible =
        hit && (expanded || !limit || shown < limit || inGrid % columns !== 0);
      card.hidden = !visible;
      if (visible) {
        shown += 1;
        inGrid += 1;
      }
    });

    sections.forEach(function (section) {
      var grid = section.querySelector("[data-persona-grid]");
      if (!grid) return;
      var any = Array.prototype.slice.call(grid.children).some(function (card) {
        return !card.hidden;
      });
      section.hidden = !any;
    });

    if (countEl) {
      if (matched === total && shown === total) {
        countEl.textContent =
          personaTotal + " persona" + (personaTotal === 1 ? "" : "s") +
          (photographs ? ", and " + photographs + " photograph" + (photographs === 1 ? "" : "s") + " published without an identifier" : "") +
          ". Select any one for the full record.";
      } else if (shown < matched) {
        countEl.textContent = "Showing " + shown + " of " + matched + " entr" + (matched === 1 ? "y" : "ies") + (matched === total ? "" : " matching") + ".";
      } else {
        countEl.textContent = shown + " of " + total + " entries.";
      }
    }
    if (emptyEl) emptyEl.hidden = matched !== 0;
    if (moreEl && moreButton) {
      var remaining = matched - shown;
      U.hideMore(moreEl, moreButton, remaining <= 0, countEl);
      moreButton.textContent = "Show the remaining " + remaining;
    }
  }

  if (moreButton) {
    moreButton.addEventListener("click", function () {
      expanded = true;
      apply();
    });
  }

  input.addEventListener("input", U.debounce(function () {
    terms = U.terms(input.value);
    expanded = false;
    apply();
  }, DEBOUNCE_MS));

  // The column count changes with the width, so the row the limit falls in is
  // recomputed when the window is resized.
  window.addEventListener("resize", U.debounce(apply, DEBOUNCE_MS));

  apply();
})();
