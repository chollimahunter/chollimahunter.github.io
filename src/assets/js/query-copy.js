/*
  query-copy.js — a copy button on every hunt query
  ===================================================================

  Progressive enhancement over layouts/hunt.njk. Each query is rendered
  server-side as <pre class="query-block"><code>…</code></pre> and is fully
  readable, and selectable, with this script absent; all this adds is a
  one-click copy of the query text so a reader can paste it into a console
  without dragging across a forty-line KQL block.

  Contract with the markup (layouts/hunt.njk):
    - each query sits in a .hunt-query, whose head carries a
      <button data-copy-query hidden> and whose <pre class="query-block">
      holds the text to copy
    - the button carries `hidden` in the markup and is revealed here, so a
      reader without JavaScript never sees a control that does nothing

  What is copied is the <code> element's textContent: the query exactly as
  the page shows it, comments included, since the comments are part of what
  the site authored. The button's label changes to say it worked, or did
  not, and reverts after a moment; nothing else on the page changes.
*/
(function () {
  "use strict";

  var buttons = document.querySelectorAll("[data-copy-query]");
  if (!buttons.length) return;

  function textFor(button) {
    var block = button.closest(".hunt-query");
    var code = block && block.querySelector(".query-block code, .query-block");
    return code ? code.textContent : "";
  }

  // The label change is visual; this reads the same word out to a screen
  // reader, which does not announce a button relabelling itself.
  var live = document.createElement("p");
  live.className = "visually-hidden";
  live.setAttribute("role", "status");
  document.body.appendChild(live);

  // Older browsers and insecure contexts have no navigator.clipboard; a
  // temporary textarea and execCommand still work there. Selecting it takes
  // focus, which goes back to wherever it was once the copy is done.
  function fallbackCopy(text) {
    var previous = document.activeElement;
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "visually-hidden";
    document.body.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    if (previous && previous.focus) previous.focus({ preventScroll: true });
    return ok;
  }

  function settle(button, label) {
    var original = button.getAttribute("data-label") || button.textContent;
    button.setAttribute("data-label", original);
    button.textContent = label;
    live.textContent = label;
    window.setTimeout(function () {
      live.textContent = "";
      button.textContent = original;
    }, 1800);
  }

  Array.prototype.forEach.call(buttons, function (button) {
    button.hidden = false;
    button.addEventListener("click", function () {
      var text = textFor(button);
      if (!text) return;
      // The older command is tried only when the async clipboard API is
      // missing or refuses: a permission prompt can hold writeText open for as
      // long as the reader takes to answer it, and a timer racing that prompt
      // reported a failure the reader then watched succeed.
      function finish(ok) {
        settle(button, ok ? "Copied" : "Copy failed");
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { finish(true); },
          function () { finish(fallbackCopy(text)); }
        );
      } else {
        finish(fallbackCopy(text));
      }
    });
  });
})();
