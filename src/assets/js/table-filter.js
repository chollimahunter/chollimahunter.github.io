/**
 * table-filter.js — client-side row filtering for a build-time table
 * ==========================================================================
 * Used by /sources/, where the whole registry is already in the page as real
 * table rows. This only hides rows that do not match what is typed; it fetches
 * nothing and renders nothing, which is what separates it from ioc-search.js —
 * that one downloads a 4,500-record index because the page cannot hold it.
 *
 * Progressive enhancement: the control is `hidden` in the markup and revealed
 * here, so a reader without JavaScript gets the full table and no dead input.
 *
 * Wiring, in the page:
 *   <div class="table-filter" hidden data-table-filter="#sources-table"
 *        data-table-filter-page="50"> …
 *     <input data-table-filter-input>
 *     <p data-table-filter-count></p>
 *   </div>
 *   <table id="sources-table"> … </table>
 *   <p data-table-filter-more hidden>
 *     <button data-table-filter-more-button></button>
 *   </p>
 *
 * data-table-filter-page caps how many matching rows are laid out at once and
 * is what the Show-more button extends; leave it off and every match renders,
 * which is what the shorter cluster citation tables want.
 *
 * A chip group inside the panel (partials/filter-chips.njk, through the
 * `chips` field of partials/table-filter.njk) narrows the rows by their
 * data-{dimension} attribute: a row shows only when, in every group with a
 * value pressed, its own value is one of them. The groups, the search and the
 * cap are applied together here, so none of them undoes another.
 */
(function () {
  "use strict";

  var U = window.siteUtils;
  var DEBOUNCE_MS = 120;

  function setUp(panel) {
    var table = document.querySelector(panel.getAttribute("data-table-filter"));
    var input = panel.querySelector("[data-table-filter-input]");
    var countEl = panel.querySelector("[data-table-filter-count]");
    if (!table || !input) return;

    var rows = [].slice.call(table.tBodies[0] ? table.tBodies[0].rows : []);
    if (!rows.length) return;

    // One lowercase haystack per row, built once. Row text does not change, so
    // rebuilding it on every keystroke would be pure waste.
    //
    // Link targets are folded in alongside the visible text. On /sources/ a row
    // shows a report title and a publisher, and the URL only ever appears as an
    // href — so searching for the domain you remember ("grumpygoose",
    // "unit42") found nothing at all, which reads as the source being absent
    // rather than as the search not looking there.
    var haystacks = rows.map(function (row) {
      var text = row.textContent;
      var links = [].slice.call(row.querySelectorAll("a[href]"));
      for (var i = 0; i < links.length; i += 1) {
        text += " " + links[i].getAttribute("href");
      }
      return text.toLowerCase().replace(/\s+/g, " ");
    });
    // table-sort.js reorders the body, and the cap below reveals the first
    // rows in the order this list holds them, so after a sort the list is
    // rebuilt from the table. The haystack travels with its row.
    for (var h = 0; h < rows.length; h += 1) {
      rows[h].tableFilterHaystack = haystacks[h];
      rows[h].tableFilterOrder = h;
    }
    function reread() {
      rows = [].slice.call(table.tBodies[0].rows);
      haystacks = rows.map(function (row) { return row.tableFilterHaystack || ""; });
    }
    table.addEventListener("tablesort", function () {
      reread();
      apply(input.value.trim());
    });
    // With no column sort chosen, rows follow Best match: while a query is
    // typed, the rows whose own cell text best matches it come first
    // (window.resultRank in result-tools.js); with none, page order.
    var ranked = false;
    function columnSorted() {
      return Boolean(table.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]'));
    }
    function rank(query) {
      if (columnSorted() || typeof window.resultRank !== "function") return;
      if (!query && !ranked) return;
      var scored = rows.map(function (row) {
        var texts = [].slice.call(row.cells).map(function (cell) { return cell.textContent; });
        return { row: row, score: query ? window.resultRank(query, texts) : 0 };
      });
      scored.sort(function (a, b) {
        return a.score - b.score || a.row.tableFilterOrder - b.row.tableFilterOrder;
      });
      var body = table.tBodies[0];
      scored.forEach(function (s) { body.appendChild(s.row); });
      ranked = Boolean(query);
      reread();
    }
    var noun = panel.getAttribute("data-table-filter-noun") || "rows";

    // An optional cap on how many matching rows are shown at once. /sources/
    // sets it because the registry is 1,288 rows and laying all of them out at
    // once is the slowest thing on the page; the cluster citation tables are a
    // few dozen rows and leave the attribute off, which means no cap at all.
    //
    // Every row stays in the markup either way. The cap is about what the
    // browser renders, not about what a reader can reach: the search below
    // still matches against all of them, and a reader without JavaScript never
    // gets here and so sees the whole table.
    //
    // The control names its table in data-table-filter-more so two filtered
    // tables on one page never fight over the same button; a bare attribute is
    // still honoured for a page with only one.
    var selector = panel.getAttribute("data-table-filter");
    var moreEl =
      document.querySelector('[data-table-filter-more="' + selector + '"]') ||
      document.querySelector("[data-table-filter-more]");
    var moreBtn = moreEl && moreEl.querySelector("[data-table-filter-more-button]");
    var pageSize = parseInt(panel.getAttribute("data-table-filter-page"), 10);
    if (!(pageSize > 0)) pageSize = rows.length;
    var limit = pageSize;

    // Chip groups: each is { dimension, chips, all, multiple }.
    var groups = [].slice.call(panel.querySelectorAll('.filter-chips[role="group"]')).map(function (group) {
      var chips = [].slice.call(group.querySelectorAll(".filter-chip"));
      return {
        dimension: chips.length ? chips[0].getAttribute("data-filter") : null,
        chips: chips,
        all: chips.filter(function (chip) { return chip.getAttribute("data-value") === "all"; })[0],
        multiple: group.hasAttribute("data-multiple"),
      };
    }).filter(function (g) { return g.dimension; });
    function pressed(chip) {
      return chip.getAttribute("aria-pressed") === "true";
    }
    function chosen(group) {
      return group.chips.filter(function (chip) { return chip !== group.all && pressed(chip); })
        .map(function (chip) { return chip.getAttribute("data-value"); });
    }
    function chipsAllow(row) {
      for (var g = 0; g < groups.length; g += 1) {
        var values = chosen(groups[g]);
        if (values.length && values.indexOf(row.getAttribute("data-" + groups[g].dimension)) === -1) return false;
      }
      return true;
    }
    groups.forEach(function (group) {
      group.chips.forEach(function (chip) {
        chip.addEventListener("click", function () {
          if (chip === group.all || !group.multiple) {
            group.chips.forEach(function (other) { other.setAttribute("aria-pressed", String(other === chip)); });
          } else {
            chip.setAttribute("aria-pressed", String(!pressed(chip)));
            var any = group.chips.some(function (other) { return other !== group.all && pressed(other); });
            if (group.all) group.all.setAttribute("aria-pressed", String(!any));
          }
          limit = pageSize;
          apply(input.value.trim());
        });
      });
    });

    function apply(query) {
      rank(query);
      var terms = U.terms(query);
      var matched = 0;
      var visible = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var ok = U.hasAll(haystacks[i], terms) && chipsAllow(rows[i]);
        if (ok) matched += 1;
        rows[i].tableFilterMatch = ok;
        var show = ok && visible < limit;
        if (show) visible += 1;
        rows[i].hidden = !show;
      }

      var rest = matched - visible;
      if (moreEl && moreBtn) {
        U.hideMore(moreEl, moreBtn, rest <= 0, countEl);
        // Left alone when there is nothing more to show, so the label never
        // reads "Show 0 more" in the markup of a button nobody can see.
        if (rest > 0) {
          moreBtn.textContent = "Show " + Math.min(pageSize, rest) + " more";
        }
      }

      if (!countEl) return;
      if (!terms.length) {
        countEl.textContent = rest
          ? "Showing " + visible + " of " + matched + " " + noun + "."
          : "Showing all " + matched + " " + noun + ".";
      } else if (matched === 0) {
        countEl.textContent = 'No ' + noun + ' match "' + query + '".';
      } else if (rest) {
        countEl.textContent =
          "Showing " + visible + " of " + matched + " " + noun + ' matching "' + query + '".';
      } else {
        countEl.textContent = matched + " of " + rows.length + " " + noun + ' matching "' + query + '".';
      }
    }

    input.addEventListener("input", U.debounce(function () {
      // A new query starts from the top again, so that typing something
      // narrow does not leave a reader scrolled past the few rows it hit.
      limit = pageSize;
      apply(input.value.trim());
    }, DEBOUNCE_MS));

    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        limit += pageSize;
        apply(input.value.trim());
      });
    }

    panel.hidden = false;
    apply("");
  }

  [].slice.call(document.querySelectorAll("[data-table-filter]")).forEach(setUp);
})();
