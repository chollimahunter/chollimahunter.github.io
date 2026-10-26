/*
  grid-more.js — cap a build-time card grid and reveal the rest on a click
  =======================================================================

  Progressive enhancement over any grid that lists more cards than
  src/_data/limits.js allows on one screen: the home page, /profiles/ and
  /remote-workers/pictures/ each lay out every named individual. Every card is
  in the markup and a reader without JavaScript gets the whole grid; all this
  does is hide the overflow and offer it back one press away.

  Contract with the markup, set up by partials/grid-more.njk:
    - the grid carries data-grid-limit, the number of cards shown at first,
      written from limits.list rather than typed
    - [data-grid-more] names the grid by selector and is `hidden` in the
      markup so a reader without this script never sees a dead control; it
      wraps [data-grid-more-button]
    - [data-grid-count], optional, is a status line rewritten to say how many
      of the total are showing

  Pressing the button shows everything at once rather than paging, and moves
  focus to the first card revealed so a keyboard reader lands on new content
  rather than on a control that has just disappeared.
*/
(function () {
  "use strict";

  var U = window.siteUtils;

  var controls = Array.prototype.slice.call(document.querySelectorAll("[data-grid-more]"));
  controls.forEach(function (moreEl) {
    var grid = document.querySelector(moreEl.getAttribute("data-grid-more"));
    var button = moreEl.querySelector("[data-grid-more-button]");
    if (!grid || !button) return;
    var baseLimit = parseInt(grid.getAttribute("data-grid-limit"), 10) || 50;
    var cards = Array.prototype.slice.call(grid.children);
    var total = cards.length;
    if (total <= baseLimit) return;
    var noun = moreEl.getAttribute("data-grid-more-noun") || "entries";
    var countEl = document.querySelector("[data-grid-count='" + moreEl.getAttribute("data-grid-more") + "']");
    var limit = baseLimit;
    var expanded = false;

    // The limit is rounded up to the end of the row it falls in, so the grid
    // never stops on a half-empty row.
    function cap() {
      var columns = U.columnsOf(grid);
      limit = Math.min(total, Math.ceil(baseLimit / columns) * columns);
      if (limit >= total) {
        cards.forEach(function (card) {
          card.hidden = false;
        });
        moreEl.hidden = true;
        if (countEl) countEl.textContent = total + " " + noun + ". Select any one for the full record.";
        return;
      }
      cards.forEach(function (card, i) {
        card.hidden = i >= limit;
      });
      button.textContent = "Show the remaining " + (total - limit) + " " + noun;
      if (countEl) {
        countEl.textContent = "Showing " + limit + " of " + total + " " + noun + ". Select any one for the full record.";
      }
      moreEl.hidden = false;
    }
    cap();

    window.addEventListener("resize", U.debounce(function () {
      if (!expanded) cap();
    }, 120));

    button.addEventListener("click", function () {
      expanded = true;
      cards.forEach(function (card) {
        card.hidden = false;
      });
      moreEl.hidden = true;
      if (countEl) {
        countEl.textContent = total + " " + noun + ". Select any one for the full record.";
      }
      var first = cards[limit];
      if (first) {
        // A card with no link of its own is not focusable until told so.
        var target = first.querySelector("a") || first;
        if (target === first) first.tabIndex = -1;
        // preventScroll: the reveal must leave the reader where they are.
        target.focus({ preventScroll: true });
      }
    });
  });
})();
