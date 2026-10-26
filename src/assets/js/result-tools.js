/*
  result-tools.js — sort and download for every search over page content
  =======================================================================

  Loaded on every page from base.njk. The indicator searches (ioc-search.js)
  sort and export from their own index; every other search on the site works
  over content already in the page, a table (the table searches, see
  partials/table-filter.njk) or a card grid (/hunts/, /remote-workers/personas/),
  and gets the same two controls from partials/result-tools.njk:

    - Sort, a <select data-result-sort>, for a card grid only: it sorts the
      cards by title. A table sorts by its column headers (table-sort.js).
    - Download, the format <select data-result-format> and its button, which
      export every item the page's search currently matches as CSV or JSON:
      a table row by its column headers and first link, a card by its title,
      link and data attributes. A row or cell content marked
      data-result-optional="<name>" is left out unless the reader ticks the
      "Include <name>" box this adds for it.

  "Matches" counts an item a "show more" cap has hidden: the table and persona
  searches record on each item whether it matched (tableFilterMatch,
  personaFilterMatch), and an item without that record counts when visible.

  This runs before filter-dropdown.js, which then renders both selects as the
  site dropdown.
*/
(function () {
  "use strict";

  var U = window.siteUtils;
  var el = U.el;

  /**
   * "Best match", the default Sort for every page-content search, shared with
   * table-filter.js, hunt-filter.js and persona-filter.js through
   * window.resultRank. It scores a matching item by its own texts (a row's
   * cells, a card's title): 0 when one of them is the query, 1 when one starts
   * with it, 2 when one contains it, 3 when only the rest of the item matched.
   * Callers keep page order within a score. ioc-search.js ranks the indicator
   * searches the same way from its index.
   */
  window.resultRank = function (query, texts) {
    var q = String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
    var best = 3;
    for (var i = 0; i < texts.length && best > 0; i += 1) {
      var t = String(texts[i] || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (t === q) best = 0;
      else if (best > 1 && t.indexOf(q) === 0) best = 1;
      else if (best > 2 && t.indexOf(q) !== -1) best = 2;
    }
    return best;
  };

  function matched(item) {
    if (typeof item.tableFilterMatch === "boolean") return item.tableFilterMatch;
    if (typeof item.personaFilterMatch === "boolean") return item.personaFilterMatch;
    return !item.hidden;
  }

  function headersOf(table) {
    var row = table.tHead && table.tHead.rows[0];
    return row
      ? Array.prototype.map.call(row.cells, function (c) {
          return c.textContent.replace(/\s+/g, " ").trim();
        })
      : [];
  }

  function items(target) {
    if (target.tagName === "TABLE") return target.tBodies[0] ? Array.prototype.slice.call(target.tBodies[0].rows) : [];
    return Array.prototype.slice.call(target.children);
  }

  // A card's own name or title element first, so a badge inside the card's
  // link (LIVE, a confidence level) stays out of the title.
  var TITLE_SELECTORS = ["[class*='__name']", "[class*='__title']", "h2", "h3", "h4", "a"];
  function titleOf(item) {
    for (var i = 0; i < TITLE_SELECTORS.length; i += 1) {
      var h = item.querySelector(TITLE_SELECTORS[i]);
      if (h && h.textContent.trim()) {
        var copy = h.cloneNode(true);
        Array.prototype.forEach.call(copy.querySelectorAll(".badge"), function (b) {
          b.remove();
        });
        return copy.textContent.replace(/\s+/g, " ").trim();
      }
    }
    return item.textContent.replace(/\s+/g, " ").trim();
  }
  window.resultTitleOf = titleOf;

  function cellText(cell, included) {
    var copy = cell.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll("[data-result-optional]"), function (node) {
      if (!included[node.getAttribute("data-result-optional")]) node.remove();
    });
    return copy.textContent.replace(/\s+/g, " ").trim();
  }

  function recordOf(target, item, headers, included) {
    var out = {};
    if (target.tagName === "TABLE") {
      Array.prototype.forEach.call(item.cells, function (cell, i) {
        out[headers[i] || "column " + (i + 1)] = cellText(cell, included || {});
      });
    } else {
      out.title = titleOf(item);
      Array.prototype.forEach.call(item.attributes, function (attr) {
        if (/^data-/.test(attr.name) && attr.name !== "data-search") out[attr.name.slice(5)] = attr.value;
      });
    }
    var link = item.querySelector("a[href]");
    if (link) out.url = new URL(link.getAttribute("href"), location.href).href;
    return out;
  }

  function sortGrid(grid, value) {
    // The page's filter ranks by Best match only while this says "default".
    grid.setAttribute("data-result-sorted", value);
    var list = items(grid);
    if (value === "default") {
      list.sort(function (a, b) {
        return (a._resultOrder || 0) - (b._resultOrder || 0);
      });
    } else {
      list.sort(function (a, b) {
        var c = titleOf(a).localeCompare(titleOf(b));
        return value === "title:desc" ? -c : c;
      });
    }
    list.forEach(function (item) {
      grid.appendChild(item);
    });
    // The page's own filter keeps the cards in a list of its own; it listens
    // for this to re-read the order before it caps what is shown.
    grid.dispatchEvent(new CustomEvent("resultsort", { bubbles: true }));
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-result-tools]"), function (tools) {
    var target = document.querySelector(tools.getAttribute("data-result-tools"));
    if (!target) return;
    var noun = tools.getAttribute("data-result-noun") || "results";
    var isTable = target.tagName === "TABLE";
    var headers = isTable ? headersOf(target) : [];

    // Sort is for card grids; a table sorts by its column headers.
    var sortSelect = isTable ? null : tools.querySelector("[data-result-sort]");
    if (sortSelect) {
      items(target).forEach(function (item, i) {
        item._resultOrder = i;
      });
      sortSelect.addEventListener("change", function () {
        sortGrid(target, sortSelect.value);
      });
    }

    // Content a table marks data-result-optional="<name>" is left out of a
    // download unless the reader ticks "Include <name>".
    var optional = {};
    if (isTable) {
      Array.prototype.forEach.call(target.querySelectorAll("[data-result-optional]"), function (node) {
        optional[node.getAttribute("data-result-optional")] = true;
      });
    }
    var included = {};
    var anchor = tools.querySelector("[data-result-format]");
    Object.keys(optional).forEach(function (name) {
      var box = el("input");
      box.type = "checkbox";
      box.addEventListener("change", function () {
        included[name] = box.checked;
      });
      var label = el("label", "result-tools__option");
      label.appendChild(box);
      label.appendChild(document.createTextNode(" Include " + name));
      tools.insertBefore(label, anchor);
    });

    var format = tools.querySelector("[data-result-format]");
    var button = tools.querySelector("[data-result-download-button]");
    var status = tools.querySelector("[data-result-download-status]");
    if (button) {
      button.addEventListener("click", function () {
        var rows = items(target).filter(function (item) {
          var name = item.getAttribute("data-result-optional");
          return matched(item) && (!name || included[name]);
        }).map(function (item) {
          return recordOf(target, item, headers, included);
        });
        if (!rows.length) {
          if (status) status.textContent = "Nothing to download: no " + noun + " match the current search.";
          return;
        }
        var stamp = new Date().toISOString().slice(0, 10);
        var base = "chollima-" + noun.replace(/\s+/g, "-") + "-" + stamp;
        if (format && format.value === "json") {
          U.downloadBlob(JSON.stringify(rows, null, 2), base + ".json", "application/json");
        } else {
          var keys = [];
          rows.forEach(function (r) {
            Object.keys(r).forEach(function (k) {
              if (keys.indexOf(k) === -1) keys.push(k);
            });
          });
          var csv = [keys.map(U.csvCell).join(",")]
            .concat(
              rows.map(function (r) {
                return keys.map(function (k) { return U.csvCell(r[k]); }).join(",");
              })
            )
            .join("\n");
          U.downloadBlob(csv, base + ".csv", "text/csv");
        }
        if (status) status.textContent = "Downloaded " + rows.length + " " + noun + ".";
      });
    }
    tools.hidden = false;
  });
})();
