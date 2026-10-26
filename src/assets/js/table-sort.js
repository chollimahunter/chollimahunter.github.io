/*
  table-sort.js — click a column header to sort any build-time table
  ==================================================================

  Progressive enhancement over every .results-table on the site that has a
  header row: the sources registry, a cluster's citations, the candidate
  queue, the EtherHiding watchlist, a persona's claimed experience. Without
  this script every table reads exactly as built; with it each column header
  becomes a button that sorts the body by that column, ascending first, then
  descending on a second press.

  Contract with the markup:
    - a table qualifies when it has a <thead> whose cells carry scope="col";
      a two-column key/value table (row headers only) is left alone, because
      sorting "Joined LinkedIn" above "Verifications" means nothing
    - a table carrying data-no-sort is left alone
    - rows keep whatever `hidden` state table-filter.js gave them; after a
      sort the table dispatches a "tablesort" event so the filter can re-read
      the order it lays rows out in

  How a column compares: when every non-empty cell in it parses as a number
  (commas, a leading plus and a trailing per-cent sign allowed) it sorts
  numerically; when every one parses as a date (an ISO date, or a month and a
  year as LinkedIn prints them) it sorts by time; when every one is a
  confidence level (confirmed, high, medium, low) it sorts by level, strongest
  first; otherwise by text, with the browser's locale rules. Empty cells always
  sort last, whichever direction.
*/
(function () {
  "use strict";

  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  };

  // A cell marked data-sort-empty (an undated "reported" row, say) has no
  // value to sort by: it reads as empty, so it does not turn a column of dates
  // into text, and it sorts last in either direction.
  function cellText(row, index) {
    var cell = row.cells[index];
    if (!cell || cell.hasAttribute("data-sort-empty")) return "";
    return cell.textContent.replace(/\s+/g, " ").trim();
  }

  function asNumber(text) {
    var cleaned = text.replace(/[,+%\s]/g, "");
    if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return parseFloat(cleaned);
  }

  function asDate(text) {
    var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    var monthYear = /^([A-Za-z]{3,9})\.? (\d{4})/.exec(text);
    if (monthYear) {
      var month = MONTHS[monthYear[1].slice(0, 4).toLowerCase()];
      if (month === undefined) month = MONTHS[monthYear[1].slice(0, 3).toLowerCase()];
      if (month !== undefined) return Date.UTC(+monthYear[2], month, 1);
    }
    var year = /^(\d{4})$/.exec(text);
    if (year) return Date.UTC(+year[1], 0, 1);
    return null;
  }

  // A column of confidence levels sorts by level, not alphabetically: the first
  // press puts the strongest first (confirmed, high, medium, low), the second
  // reverses it. The key is the negated rank so "ascending" means strongest first.
  var RANKS = { confirmed: 4, high: 3, medium: 2, low: 1 };
  function asRank(text) {
    var rank = RANKS[text.trim().toLowerCase()];
    return rank === undefined ? null : -rank;
  }

  // Decide once per sort how the whole column compares, from the cells that
  // have anything in them. A column of counts with one "—" in it is still a
  // column of counts.
  function columnKind(rows, index) {
    var numeric = true;
    var dated = true;
    var ranked = true;
    var any = false;
    for (var i = 0; i < rows.length; i += 1) {
      var text = cellText(rows[i], index);
      if (!text || text === "—" || text === "-") continue;
      any = true;
      if (numeric && asNumber(text) === null) numeric = false;
      if (dated && asDate(text) === null) dated = false;
      if (ranked && asRank(text) === null) ranked = false;
      if (!numeric && !dated && !ranked) break;
    }
    if (!any) return "text";
    if (ranked) return "rank";
    if (numeric) return "number";
    if (dated) return "date";
    return "text";
  }

  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function sortTable(table, index, direction) {
    var body = table.tBodies[0];
    var rows = [].slice.call(body.rows);
    var kind = columnKind(rows, index);
    var keyed = rows.map(function (row, position) {
      var text = cellText(row, index);
      var empty = !text || text === "—" || text === "-";
      var key = kind === "number" ? asNumber(text) : kind === "date" ? asDate(text) : kind === "rank" ? asRank(text) : text.toLowerCase();
      return { row: row, position: position, empty: empty, key: key };
    });
    keyed.sort(function (a, b) {
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      var order = 0;
      if (!a.empty) {
        if (kind === "text") order = collator.compare(a.key, b.key);
        else order = a.key - b.key;
        if (direction === "descending") order = -order;
      }
      return order || a.position - b.position;
    });
    for (var i = 0; i < keyed.length; i += 1) body.appendChild(keyed[i].row);
  }

  function setUp(table) {
    if (table.hasAttribute("data-no-sort")) return;
    var head = table.tHead;
    if (!head || !head.rows.length || !table.tBodies.length) return;
    var headers = [].slice.call(head.rows[0].cells).filter(function (cell) {
      return cell.getAttribute("scope") === "col";
    });
    if (headers.length < 2) return;

    var cells = [].slice.call(head.rows[0].cells);
    cells.forEach(function (cell, index) {
      if (cell.getAttribute("scope") !== "col" || !cell.textContent.trim()) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "table-sort__button";
      while (cell.firstChild) button.appendChild(cell.firstChild);
      cell.appendChild(button);
      cell.setAttribute("aria-sort", "none");
      button.addEventListener("click", function () {
        var current = cell.getAttribute("aria-sort");
        var next = current === "ascending" ? "descending" : "ascending";
        cells.forEach(function (other) {
          if (other.hasAttribute("aria-sort")) other.setAttribute("aria-sort", "none");
        });
        cell.setAttribute("aria-sort", next);
        sortTable(table, index, next);
        table.dispatchEvent(new CustomEvent("tablesort", { bubbles: true }));
      });
    });
  }

  var tables = document.querySelectorAll("table.results-table");
  for (var t = 0; t < tables.length; t += 1) setUp(tables[t]);
})();
