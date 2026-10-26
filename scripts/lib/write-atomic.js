/**
 * write-atomic.js — crash-safe writes for the live data files under src/_data.
 * ==========================================================================
 * A plain fs.writeFileSync truncates the target before the new bytes land, so
 * a process killed mid-write (Ctrl-C, an OOM, a CI job hitting its timeout)
 * leaves a half-written JSON file behind — one every page-build reads. Writing
 * to a sibling temp file first and renaming over the target means the target
 * is always either the old complete file or the new complete file, because a
 * same-directory rename is a single filesystem operation.
 */

const fs = require("fs");
const path = require("path");

/** Writes `contents` to `filePath` without ever leaving a truncated file behind. */
function writeFileAtomic(filePath, contents) {
  const tmpPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, contents, "utf8");
  fs.renameSync(tmpPath, filePath);
}

module.exports = { writeFileAtomic };
