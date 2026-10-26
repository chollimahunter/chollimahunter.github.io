/*
  site-utils.js — the small helpers every other script shares
  =======================================================================

  Loaded on every page from base.njk, deferred and ahead of every other
  script, so window.siteUtils exists by the time any of them runs: deferred
  scripts execute in document order, the global ones in base.njk come after
  this, and a page's own scripts arrive through extra_head, which base.njk
  emits after all of them. It renders nothing and touches no page on its own.
*/
(function () {
  "use strict";

  window.siteUtils = {
    /** An element with an optional class and text, never parsed as markup. */
    el: function (tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    },

    /** `fn` run once `ms` after the last of a burst of calls. */
    debounce: function (fn, ms) {
      var timer = null;
      return function () {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
      };
    },

    /**
     * Lowercase whitespace-separated terms, and whether a lowercase haystack
     * holds every one of them: a second word narrows a search rather than
     * widening it.
     */
    terms: function (text) {
      return String(text).toLowerCase().split(/\s+/).filter(Boolean);
    },
    hasAll: function (haystack, terms) {
      for (var i = 0; i < terms.length; i += 1) {
        if (haystack.indexOf(terms[i]) === -1) return false;
      }
      return true;
    },

    /**
     * How many cards one row of a CSS grid holds at the current width, read
     * from the laid-out grid rather than assumed, since the column count
     * follows the viewport.
     */
    columnsOf: function (grid) {
      var template = window.getComputedStyle(grid).gridTemplateColumns || "";
      var count = template.split(" ").filter(Boolean).length;
      return count > 0 ? count : 1;
    },

    /**
     * Shows or hides a "show more" control. Hiding it while it holds focus
     * drops keyboard focus to the document body, so the focus goes to
     * `focusTarget` first (the count line, which also reads out what the
     * press revealed).
     */
    hideMore: function (wrap, button, hide, focusTarget) {
      if (hide && button && focusTarget && document.activeElement === button) {
        focusTarget.tabIndex = -1;
        // preventScroll: the count sits above the list, and moving focus to
        // it must not throw the reader back to the top of the page.
        focusTarget.focus({ preventScroll: true });
      }
      wrap.hidden = hide;
    },

    /**
     * One CSV cell. A cell a spreadsheet would read as a formula gets a
     * leading apostrophe, the OWASP mitigation for CSV injection, since
     * researchers' quoted text flows into these columns; a signed plain
     * number such as a phone number is left alone.
     */
    csvCell: function (value) {
      var text = value == null ? "" : String(value);
      if (/^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[0-9 ().-]+$/.test(text))) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    },

    /** Saves `content` as a file named `filename`, built in the browser. */
    downloadBlob: function (content, filename, mime) {
      var blob = new Blob([content], { type: mime + ";charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Deferred rather than immediate: revoking synchronously has, in the
      // past, raced the browser's own read of the blob on the save.
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },
  };
})();
