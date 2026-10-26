/**
 * candidates.js — the published candidate rows, and the same rows as search
 * records
 * ==========================================================================
 * Two readers of src/_data/iocs/candidates.json share the rules here.
 *
 * publishedCandidates() is what /remote-workers/candidates/ lists and what
 * each /remote-workers/candidates/{slug}/ page is built from: the rows a
 * reviewer has opened and left under review. A confirmed row is not listed
 * there. It is no longer a potential profile, and it stays on the Remote
 * Workers side through the search records below. Leads nobody has opened and
 * cleared rows are never published. The order is the page's default: highest
 * confidence first, then by name.
 *
 * recordsFromCandidates() turns the rows rated medium or high confidence,
 * under review or confirmed, into index records, so their accounts are
 * findable from the /remote-workers/ search. An under-review row goes through
 * the dossier loader as an unattributed group: it anchors no persona, because
 * a candidate is not an attribution. A confirmed row is one, so it goes
 * through as a dossier under its name and opens a persona on
 * /remote-workers/personas/, merging with any dossier already filed under the
 * same name (scripts/lib/dossiers.js keys a persona by name). The records carry their own provenance label,
 * `candidate`, which ranks below every other label, so a value any other
 * source already holds keeps that source's label and the candidate citation
 * is added beside it. An under-review row cites its own page; a confirmed row
 * has none, so its citation carries the whole review and points at the
 * Remote Workers search.
 */
const { recordsFromDossiers } = require("./dossiers.js");
const { normalizeEmail, normalizeGithub, normalizeLinkedin, normalizePhone } = require("./ioc-normalize.js");

// A row's indicator list also holds context links, such as a company's
// LinkedIn employee page, that are not an account. Only a value that
// normalizes as its type is an indicator.
const NORMALIZE = {
  email_address: normalizeEmail,
  github_profile: normalizeGithub,
  linkedin_profile: normalizeLinkedin,
  phone_number: normalizePhone,
};

const SITE = "https://chollimahunter.github.io";
const LIST_PATH = "/remote-workers/candidates/";
const REMOTE_WORKERS = `${SITE}/remote-workers/`;
const INDEXED = new Set(["under-review", "confirmed"]);
const RATED = new Set(["medium", "high"]);
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

/** The address of a published row's own page, relative to the site root. */
function candidatePath(row) {
  return `${LIST_PATH}${row.slug}/`;
}

/**
 * The rows the candidates page lists, in its default order. Each carries
 * `display_name` (the name the persona presents under, `name`, or its slug
 * where none is recorded), `confidence_rank` for the table's sort, and `path`.
 */
function publishedCandidates(queue) {
  if (!queue || !Array.isArray(queue.candidates)) return [];
  return queue.candidates
    .filter((row) => row.status === "under-review")
    .map((row) => {
      const confidence = (row.facts || {}).confidence;
      return {
        ...row,
        display_name: row.name || row.slug,
        confidence_rank: confidence in CONFIDENCE_RANK ? CONFIDENCE_RANK[confidence] : 3,
        path: candidatePath(row),
      };
    })
    .sort(
      (a, b) =>
        a.confidence_rank - b.confidence_rank ||
        a.display_name.localeCompare(b.display_name, "en", { sensitivity: "base" }) ||
        a.slug.localeCompare(b.slug)
    );
}

function recordsFromCandidates(queue) {
  if (!queue || !Array.isArray(queue.candidates)) return [];
  const unattributed = [];
  const dossiers = [];
  for (const row of queue.candidates) {
    const facts = row.facts || {};
    if (!INDEXED.has(row.status) || !RATED.has(facts.confidence)) continue;
    const indicators = (facts.indicators || [])
      .filter((i) => i && NORMALIZE[i.type] && NORMALIZE[i.type](i.value))
      .map((i) => ({ ioc_type: i.type, value: i.value }));
    if (!indicators.length) continue;
    const confirmed = row.status === "confirmed";
    const date = row.last_checked || row.first_seen || null;
    const corroboration = (row.corroboration || [])
      .map((s) => [s.title || s.url, s.publisher].filter(Boolean).join(", "))
      .join("; ");
    (confirmed && row.name ? dossiers : unattributed).push({
      ...(confirmed && row.name ? { persona: row.name } : {}),
      researcher: "chollimahunter",
      label: `Potential DPRK profile, ${facts.confidence} confidence, ${confirmed ? "confirmed" : "under review"}`,
      transcribed: date,
      posts: [{ url: confirmed ? REMOTE_WORKERS : `${SITE}${candidatePath(row)}`, date }],
      indicators,
      note: confirmed
        ? `Confirmed by Chollima Hunter research and rated ${facts.confidence} confidence${corroboration ? `; corroborated by ${corroboration}` : ""}. ${row.note || ""}`.trim()
        : `Queued on Potential DPRK Profiles and rated ${facts.confidence} confidence by a reviewer. Not confirmed; see the profile's page for the review.`,
    });
  }
  return recordsFromDossiers({
    researchers: { chollimahunter: { publisher: "Chollima Hunter", account: REMOTE_WORKERS } },
    defaults: { method: "candidate", campaign: ["IT Worker Fraud"] },
    dossiers,
    unattributed,
  });
}

module.exports = { publishedCandidates, recordsFromCandidates, candidatePath };
