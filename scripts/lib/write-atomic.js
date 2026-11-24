/**
 * write-atomic.js — crash-safe writes for the live data files under src/_data.
 * ==========================================================================
 * A plain fs.writeFileSync truncates the target before the new bytes land, so
 * a process killed mid-write (Ctrl-C, an OOM, a CI job hitting its timeout)
 * leaves a half-written JSON file behind — one every page-build reads. Writing
 * to a sibling temp file first and renaming over the target means the target
 * is always either the old complete file or the new complete file, because a
 * same-directory rename is a single filesystem operation.
 *
 * On Windows the rename fails with EPERM, EACCES or EBUSY while another
 * process (a virus scanner, the search indexer, git) briefly holds the target
 * open; a five-hour pivot run died that way on 23 November 2026. The rename is
 * retried with a short wait before the error is thrown.
 */

const fs = require("fs");
const path = require("path");

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Renames, retrying a transient lock up to `tries` times with a growing wait. */
function renameWithRetry(from, to, tries = 8, rename = fs.renameSync) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rename(from, to);
    } catch (err) {
      if (!TRANSIENT.has(err.code) || attempt >= tries) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

/** Writes `contents` to `filePath` without ever leaving a truncated file behind. */
function writeFileAtomic(filePath, contents) {
  const tmpPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, contents, "utf8");
  try {
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

module.exports = { writeFileAtomic, renameWithRetry };
