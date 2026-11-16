/*
  moved-page.js — send an old indicator address on from the 404 page
  ==================================================================

  Loaded only by src/404.njk. Repository indicators were typed `other` until
  27 September 2026, and their /indicators/other-…/ addresses were public for
  two days. GitHub Pages serves 404.html for any path with no file, so when
  the path is one of those addresses this looks it up in
  /assets/data/indicator-moved.json and replaces the page with the one that
  took its place. Any other path, or an address the map does not hold, is
  left on the 404 page. Without JavaScript the reader gets the 404 page.
*/
(function () {
  "use strict";

  var match = /^\/indicators\/other-([0-9a-f]{12})\/?$/.exec(location.pathname);
  if (!match) return;
  var status = document.querySelector("[data-moved-status]");
  if (status) status.hidden = false;
  fetch("/assets/data/indicator-moved.json")
    .then(function (response) {
      return response.ok ? response.json() : {};
    })
    .then(function (moved) {
      var id = moved[match[1]];
      if (id && /^[a-z0-9-]+$/.test(id)) location.replace("/indicators/" + id + "/");
      else if (status) status.hidden = true;
    })
    .catch(function () {
      if (status) status.hidden = true;
    });
})();
