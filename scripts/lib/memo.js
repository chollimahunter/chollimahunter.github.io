/**
 * memo.js — build-once caching for the expensive data modules
 * ==========================================================================
 * src/_data/iocIndex.js and src/_data/personas.js each merge every file under
 * src/_data/iocs/ into ~15,000 records. Eleventy calls each data module once
 * per build, but src/_data/clusters.js and src/_data/sources.js call the same
 * functions directly to derive their own views, so without this the merge ran
 * three times over for one build.
 *
 * The cache is keyed on the names, sizes and modification times of every file
 * in the data directory rather than held for the life of the process, so a
 * watching dev server that edits a data file still sees the new records on
 * the next build, and an unchanged directory returns the previous result.
 */

const fs = require("fs");
const path = require("path");

function fingerprint(dir) {
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    })
    .join("|");
}

/**
 * Wrap `build` so it runs again only when something in `dir` has changed.
 */
function memoByDir(dir, build) {
  let key = null;
  let value;
  return function () {
    const now = fingerprint(dir);
    if (now !== key) {
      value = build();
      key = now;
    }
    return value;
  };
}

module.exports = { memoByDir };
