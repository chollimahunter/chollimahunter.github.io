/*
  table-stack.js — every wide table reads as cards when it would not fit
  =======================================================================

  Loaded on every page from base.njk, beside table-sort.js. No page on this
  site scrolls sideways. tokens.css lets a .results-table cell's long tokens
  (URLs, addresses, hashes) wrap, which keeps most tables inside their column;
  a table of four or more columns can still be too cramped on a narrow screen
  or too wide for the window, so this labels each body cell with its column's
  header text and, whenever the table would not fit, marks it
  .results-table--stacked, which tokens.css lays out as one card of
  label-and-value lines per row. It re-checks on resize.

  A table stacks below 64rem, or at any width where it is wider than the
  window. Tables with fewer columns stay tables. A table carrying data-no-stack
  is left alone. Without JavaScript the table stays a table.

  A table of eight or more columns is also marked .results-table--wide: on a
  desktop screen it extends past the reading column, centred, while the page
  around it keeps the same column as every other page.
*/
(function () {
  "use strict";

  var MIN_COLUMNS = 4;
  var WIDE_COLUMNS = 8;
  var NARROW = "(max-width: 64rem)";

  var tables = [];
  Array.prototype.forEach.call(document.querySelectorAll("table.results-table"), function (table) {
    if (table.hasAttribute("data-no-stack")) return;
    var headRow = table.tHead && table.tHead.rows[0];
    if (!headRow) return;
    var labels = Array.prototype.map.call(headRow.cells, function (cell) {
      return cell.textContent.replace(/\s+/g, " ").trim();
    });
    if (labels.length < MIN_COLUMNS) return;
    Array.prototype.forEach.call(table.tBodies, function (body) {
      Array.prototype.forEach.call(body.rows, function (row) {
        Array.prototype.forEach.call(row.cells, function (cell, i) {
          if (labels[i] && !cell.hasAttribute("data-label")) cell.setAttribute("data-label", labels[i]);
        });
      });
    });
    if (labels.length >= WIDE_COLUMNS) table.classList.add("results-table--wide");
    tables.push(table);
  });
  if (!tables.length) return;

  // A stacked table's header row is clipped out of sight, so the sort buttons
  // table-sort.js put there leave the tab order while it is stacked, where a
  // table with a search keeps its Sort dropdown.
  function headButtons(table, reachable) {
    Array.prototype.forEach.call(table.tHead.querySelectorAll("button"), function (button) {
      if (reachable) button.removeAttribute("tabindex");
      else button.tabIndex = -1;
    });
  }

  // Lay each table out as a table first, then stack it if it does not fit.
  function fit() {
    var narrow = window.matchMedia(NARROW).matches;
    var width = document.documentElement.clientWidth;
    tables.forEach(function (table) {
      table.classList.remove("results-table--stacked");
      var stacked = narrow;
      if (!stacked) {
        var box = table.getBoundingClientRect();
        stacked = box.left < 0 || box.right > width;
      }
      if (stacked) table.classList.add("results-table--stacked");
      headButtons(table, !stacked);
    });
  }

  // Measured again whenever what the table shows can have changed: the window
  // resized, the page finished loading (a table search caps its rows, web fonts
  // arrive), a reader typed in a search or sorted, or a script rendered rows
  // into a table ("tablerender", from ioc-search.js, which labels its own cells).
  var later = window.siteUtils.debounce(fit, 150);
  window.addEventListener("resize", later);
  window.addEventListener("load", later);
  document.addEventListener("input", later);
  document.addEventListener("tablesort", later, true);
  document.addEventListener("tablerender", later, true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(later);
  fit();
})();
