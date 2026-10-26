/**
 * compare.js — the one text ordering the build uses
 * ==========================================================================
 * An unpinned localeCompare sorts by the locale of whichever machine runs the
 * build, and the order is baked into the site: which records fall into each
 * sitemap file and each browse page, which persona gets a name's plain slug.
 * Pinned to English so a local build and the deploy agree.
 */
"use strict";

const collator = new Intl.Collator("en");

/** Compares two strings; null and undefined sort as "". */
function compareText(a, b) {
  return collator.compare(a == null ? "" : String(a), b == null ? "" : String(b));
}

module.exports = { compareText };
