/**
 * personas.js — the persona listing, for the Personas tab
 * ==========================================================================
 * A thin read-and-group shim. All the grouping logic, and the reasoning behind
 * it, lives in scripts/lib/personas.js, which src/_data/iocIndex.js shares so
 * the tag on a search result and the page it links to can never disagree.
 *
 * Consumed by:
 *   src/remote-workers/personas/index.njk        — the listing
 *   src/remote-workers/personas/persona-page.njk — one page per persona
 */

const fs = require("fs");
const path = require("path");

const { buildPersonas } = require("../../scripts/lib/personas.js");
const { recordsFromDossiers } = require("../../scripts/lib/dossiers.js");
const { recordsFromCandidates } = require("../../scripts/lib/candidates.js");
const { memoByDir } = require("../../scripts/lib/memo.js");

const SCRAPED_PATH = path.join(__dirname, "iocs", "scraped-iocs.json");
const DOSSIERS_PATH = path.join(__dirname, "iocs", "x-dossiers.json");
const REGISTRIES_PATH = path.join(__dirname, "iocs", "third-party-registries.json");
const OBSERVATIONS_PATH = path.join(__dirname, "iocs", "direct-observations.json");
const CANDIDATES_PATH = path.join(__dirname, "iocs", "candidates.json");

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Every record that can form a persona: the scraper's output, the
 * hand-transcribed dossiers, and the candidate rows (a confirmed one is filed
 * as a persona; see scripts/lib/candidates.js). Exported so src/_data/iocIndex.js tags search
 * results from exactly the same set the pages are built from.
 */
function personaRecords() {
  const scraped = readJson(SCRAPED_PATH, { records: [] }).records || [];
  const dossiers = recordsFromDossiers(readJson(DOSSIERS_PATH, null));
  const registries = recordsFromDossiers(readJson(REGISTRIES_PATH, null));
  const observations = recordsFromDossiers(readJson(OBSERVATIONS_PATH, null));
  const candidates = recordsFromCandidates(readJson(CANDIDATES_PATH, null));
  return [...scraped, ...dossiers, ...registries, ...observations, ...candidates];
}

// Built once per set of data files, however many modules ask for it: see
// scripts/lib/memo.js.
module.exports = memoByDir(path.join(__dirname, "iocs"), function () {
  return buildPersonas(personaRecords());
});

module.exports.personaRecords = personaRecords;
