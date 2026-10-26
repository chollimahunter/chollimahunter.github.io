/*
  filter-dropdown.js — the site's one dropdown control
  =======================================================================

  Loaded on every page from base.njk. Every choice-of-one control on the site
  renders through this, so a filter, a sort order and a download format all
  look and behave the same:

    - a filter-chip group (.filter-chips[role="group"] holding .filter-chip
      buttons; see partials/filter-chips.njk and the /hunts/ filters), and
    - a native <select>.

  A chip group marked data-multiple takes several choices: picking an option
  toggles its chip and leaves the panel open, and the button lists every chip
  that is pressed. The page script still decides what pressing a chip means.

  Each becomes one button showing the current choice, which opens a panel with
  a search box and the list of options. The original control stays in the
  page, hidden, and remains the source of truth: picking an option clicks the
  chip it stands for, or sets the <select> and fires its change event, so the
  page's own script (ioc-search.js, hunt-filter.js and the rest) filters,
  sorts or updates the URL exactly as before. A MutationObserver keeps the
  label in step when that script changes the chip itself.

  Adjacent controls are gathered into one .filter-dropdowns row. A reader
  without JavaScript keeps the original chips and selects.

  Keyboard: the search box takes focus when the panel opens; ArrowUp and
  ArrowDown move through the visible options, Home and End jump to the first
  and last, Enter picks one, Escape closes the panel and returns focus to the
  button.
*/
(function () {
  "use strict";

  var el = window.siteUtils.el;
  var counter = 0;
  var dropdowns = [];

  function closeOthers(keep) {
    dropdowns.forEach(function (wrap) {
      if (wrap !== keep) wrap._close(false);
    });
  }

  // The row a new dropdown joins: the row just before its source, looking past
  // sources already replaced (they are hidden and sit between the widgets).
  function rowBefore(source) {
    var prev = source.previousElementSibling;
    while (prev && prev.hasAttribute("data-dropdown-source")) prev = prev.previousElementSibling;
    return prev && prev.classList.contains("filter-dropdowns") ? prev : null;
  }

  /*
    `items` is a list of { text, selected(), choose() }. `name` is the short
    label shown on the button; `groupLabel` the accessible name of the list.
  */
  function build(source, items, name, groupLabel, inline, multiple) {
    counter += 1;
    var id = "filter-dropdown-" + counter;

    var wrap = el("div", "filter-dropdown");
    var button = el("button", "filter-dropdown__button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", id + "-panel");
    if (name) button.appendChild(el("span", "filter-dropdown__name", name));
    var valueEl = el("span", "filter-dropdown__value");
    button.appendChild(valueEl);

    var panel = el("div", "filter-dropdown__panel");
    panel.id = id + "-panel";
    panel.hidden = true;
    var noun = (name || groupLabel || "options").toLowerCase();
    var search = el("input", "filter-dropdown__search");
    search.type = "search";
    search.placeholder = "Search " + noun;
    search.setAttribute("aria-label", "Search " + noun);
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-autocomplete", "list");
    search.setAttribute("aria-controls", id + "-list");
    search.autocomplete = "off";
    var list = el("ul", "filter-dropdown__list");
    list.id = id + "-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", groupLabel || name || "Options");
    if (multiple) list.setAttribute("aria-multiselectable", "true");
    var empty = el("p", "filter-dropdown__empty", "No matching options");
    empty.hidden = true;

    var options = items.map(function (item, i) {
      var option = el("li", "filter-dropdown__option", item.text);
      option.id = id + "-opt-" + i;
      option.setAttribute("role", "option");
      option.addEventListener("mousedown", function (event) {
        event.preventDefault();
      });
      option.addEventListener("click", function () {
        choose(item);
      });
      list.appendChild(option);
      return { item: item, option: option, text: item.text.toLowerCase() };
    });

    panel.appendChild(search);
    panel.appendChild(list);
    panel.appendChild(empty);
    wrap.appendChild(button);
    wrap.appendChild(panel);

    // Placement: join the row the previous control opened, open a new row, or
    // (a lone select inside a line of other controls) sit in its place.
    var row = rowBefore(source);
    if (row) {
      row.appendChild(wrap);
    } else if (inline) {
      source.parentNode.insertBefore(wrap, source);
    } else {
      row = el("div", "filter-dropdowns");
      row.appendChild(wrap);
      source.parentNode.insertBefore(row, source);
    }
    source.setAttribute("data-dropdown-source", "");
    source.hidden = true;

    var active = -1;

    function sync() {
      var chosen = [];
      options.forEach(function (entry) {
        var selected = entry.item.selected();
        entry.option.setAttribute("aria-selected", String(selected));
        if (selected) chosen.push(entry.item.text);
      });
      if (chosen.length) valueEl.textContent = multiple ? chosen.join(", ") : chosen[chosen.length - 1];
    }

    function visible() {
      return options.filter(function (entry) {
        return !entry.option.hidden;
      });
    }

    function setActive(index) {
      var shown = visible();
      options.forEach(function (entry) {
        entry.option.classList.remove("filter-dropdown__option--active");
      });
      if (!shown.length) {
        active = -1;
        search.removeAttribute("aria-activedescendant");
        return;
      }
      active = Math.max(0, Math.min(index, shown.length - 1));
      var current = shown[active].option;
      current.classList.add("filter-dropdown__option--active");
      search.setAttribute("aria-activedescendant", current.id);
      // Scrolls the option list only; scrollIntoView would also scroll the page.
      var list = current.parentNode;
      var over = current.getBoundingClientRect();
      var box = list.getBoundingClientRect();
      if (over.top < box.top) list.scrollTop -= box.top - over.top;
      else if (over.bottom > box.bottom) list.scrollTop += over.bottom - box.bottom;
    }

    function applySearch() {
      var term = search.value.trim().toLowerCase();
      var any = false;
      options.forEach(function (entry) {
        var hit = !term || entry.text.indexOf(term) !== -1;
        entry.option.hidden = !hit;
        if (hit) any = true;
      });
      empty.hidden = any;
      setActive(0);
    }

    function open() {
      closeOthers(wrap);
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      search.setAttribute("aria-expanded", "true");
      search.value = "";
      applySearch();
      var shown = visible();
      for (var i = 0; i < shown.length; i += 1) {
        if (shown[i].item.selected()) {
          setActive(i);
          break;
        }
      }
      search.focus({ preventScroll: true });
    }

    function close(returnFocus) {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      search.setAttribute("aria-expanded", "false");
      if (returnFocus) button.focus({ preventScroll: true });
    }

    // Closed first: a chip's click bubbles to the document listener that
    // closes a panel on an outside click, which would otherwise close this one
    // before focus could be handed back to the button.
    function choose(item) {
      if (multiple) {
        item.choose();
        sync();
        search.focus({ preventScroll: true });
        return;
      }
      close(true);
      if (!item.selected()) item.choose();
      sync();
    }

    wrap._close = close;
    wrap._source = source;
    dropdowns.push(wrap);

    button.addEventListener("click", function () {
      if (panel.hidden) open();
      else close(false);
    });
    button.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" && panel.hidden) {
        event.preventDefault();
        open();
      }
    });
    search.addEventListener("input", applySearch);
    search.addEventListener("keydown", function (event) {
      var shown = visible();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(active + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(active - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setActive(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActive(shown.length - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (shown[active]) choose(shown[active].item);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Tab") {
        close(false);
      }
    });

    sync();
    return sync;
  }

  function enhanceChips(group) {
    var chips = Array.prototype.slice.call(group.querySelectorAll(".filter-chip"));
    if (!chips.length) return;
    var sync = build(
      group,
      chips.map(function (chip) {
        return {
          text: chip.textContent.trim(),
          selected: function () {
            return chip.getAttribute("aria-pressed") === "true";
          },
          choose: function () {
            chip.click();
          },
        };
      }),
      group.getAttribute("data-short-label") || "",
      group.getAttribute("aria-label"),
      false,
      group.hasAttribute("data-multiple")
    );
    var observer = new MutationObserver(sync);
    chips.forEach(function (chip) {
      observer.observe(chip, { attributes: true, attributeFilter: ["aria-pressed"] });
    });
  }

  function enhanceSelect(select) {
    var sync = build(
      select,
      Array.prototype.map.call(select.options, function (opt) {
        return {
          text: opt.textContent.trim(),
          selected: function () {
            return select.value === opt.value;
          },
          choose: function () {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          },
        };
      }),
      select.getAttribute("data-short-label") || "",
      select.getAttribute("aria-label"),
      true
    );
    select.addEventListener("change", sync);
  }

  function enhanceAll() {
    // In document order, so adjacent controls land in one row in order.
    var sources = document.querySelectorAll('.filter-chips[role="group"], select');
    Array.prototype.forEach.call(sources, function (source) {
      if (source.hasAttribute("data-dropdown-source") || source.closest("noscript")) return;
      if (source.tagName === "SELECT") enhanceSelect(source);
      else enhanceChips(source);
    });
  }

  document.addEventListener("click", function (event) {
    dropdowns.forEach(function (wrap) {
      // The hidden chip a multi-select option clicks is the event's target
      // too, and that click must not close the panel it came from.
      if (!wrap.contains(event.target) && !wrap._source.contains(event.target)) wrap._close(false);
    });
  });

  // A page script may build or reveal its controls after this one runs (the
  // index-backed searches reveal their panel once the index loads), but the
  // chips and selects are all in the markup, so one pass is enough.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enhanceAll);
  else enhanceAll();
})();
