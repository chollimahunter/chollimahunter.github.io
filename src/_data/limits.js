/**
 * limits.js — how many rows a page lays out before it asks for the rest
 * ==========================================================================
 * One number, in one place, for every list on this site that can grow without
 * bound. Change it here and every page follows.
 *
 * The problem it solves is that almost every list on this site is fed by a
 * dataset that keeps growing. A cluster page carried all 904 of its citations
 * and all 80 of its named individuals in the markup because each was written
 * as a plain loop over whatever the data module handed it, and each was a
 * reasonable length on the day it was written. The cap is therefore a default
 * applied everywhere rather than a fix applied to the pages that got long.
 *
 * Capping means laying out `list` rows and leaving the rest one click away —
 * never dropping them. A reader without JavaScript must still get the whole
 * list, because the progressive-enhancement rule in CLAUDE.md applies here as
 * much as anywhere: `table-filter.js` keeps every row in the markup and only
 * hides the overflow, and a build-time slice always sits beside a link to the
 * page that carries the full set.
 *
 * Consumed by:
 *   src/_data/clusters.js            — indicator, profile and hunt previews
 *   src/_data/iocIndex.js            — the no-JavaScript indicator fallback
 *   src/_includes/layouts/cluster.njk — the citations table page size
 *   src/sources/index.njk            — the source registry page size
 *   src/repo-scanner/index.njk       — the scan-match table page size
 *   src/etherhiding/*                 — the watchlist and findings page sizes
 *   src/index.md, src/profiles/index.njk, src/remote-workers/pictures/index.njk
 *                                     — the profile grids, capped by grid-more.js
 *   src/remote-workers/personas/index.njk — the persona grid, capped by persona-filter.js
 *   src/remote-workers/personas/persona-page.njk — a persona's indicator cards
 *   src/sources/index.njk            — each source's list of cited posts
 *   src/_includes/layouts/hunt.njk   — a hunt's indicator table
 *
 * The client-side scripts that page a list read their size from a data
 * attribute the markup sets from this file. Each still carries a literal as a
 * last-resort fallback for a panel rendered without the attribute; those are
 * the only other numbers, and they exist so a missing attribute degrades to a
 * sensible page rather than to one row.
 */

module.exports = {
  /** Rows laid out at once in any list, table or card grid. */
  list: 50,
  /**
   * The one exception: links per page on /indicators/browse/. Those pages
   * exist so a crawler can reach every indicator page in few hops, and each
   * row is a single link, so they are paged at build time rather than capped.
   */
  browse: 200,
};
