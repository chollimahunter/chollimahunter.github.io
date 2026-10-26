/**
 * register-filter.js — narrows rendered table rows by a filter-chip group
 * ==========================================================================
 * Used by /remote-workers/red-flags/, where every register row is already in
 * the page. A chip group written through partials/filter-chips.njk with a
 * `rows` selector (data-row-filter) hides the rows inside that element whose
 * data-{dimension} value is not pressed, and hides any data-row-filter-section
 * left with no row showing, heading included.
 *
 * With data-multiple several chips can be pressed at once: pressing "All"
 * clears the others, and releasing the last one presses "All" again.
 *
 * Progressive enhancement: the chips sit in a wrapper marked
 * data-row-filter-panel and `hidden` in the markup; this reveals it, so a
 * reader without JavaScript gets every row and no dead control.
 */
(function () {
  "use strict";

  function setUp(group) {
    var scope = document.querySelector(group.getAttribute("data-row-filter"));
    var chips = [].slice.call(group.querySelectorAll(".filter-chip"));
    if (!scope || !chips.length) return;
    var dimension = chips[0].getAttribute("data-filter");
    var multiple = group.hasAttribute("data-multiple");
    var all = chips.filter(function (chip) { return chip.getAttribute("data-value") === "all"; })[0];
    var rows = [].slice.call(scope.querySelectorAll("[data-" + dimension + "]"));
    var sections = [].slice.call(scope.querySelectorAll("[data-row-filter-section]"));

    function pressed(chip) {
      return chip.getAttribute("aria-pressed") === "true";
    }

    function apply() {
      var chosen = chips.filter(function (chip) { return chip !== all && pressed(chip); })
        .map(function (chip) { return chip.getAttribute("data-value"); });
      rows.forEach(function (row) {
        row.hidden = chosen.length > 0 && chosen.indexOf(row.getAttribute("data-" + dimension)) === -1;
      });
      sections.forEach(function (section) {
        section.hidden = !section.querySelector("[data-" + dimension + "]:not([hidden])");
      });
    }

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        if (chip === all || !multiple) {
          chips.forEach(function (other) { other.setAttribute("aria-pressed", String(other === chip)); });
        } else {
          chip.setAttribute("aria-pressed", String(!pressed(chip)));
          var any = chips.some(function (other) { return other !== all && pressed(other); });
          if (all) all.setAttribute("aria-pressed", String(!any));
        }
        apply();
      });
    });

    var panel = group.closest("[data-row-filter-panel]");
    if (panel) panel.hidden = false;
    apply();
  }

  document.querySelectorAll(".filter-chips[data-row-filter]").forEach(setUp);
})();
