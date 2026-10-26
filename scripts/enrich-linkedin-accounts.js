#!/usr/bin/env node
/**
 * enrich-linkedin-accounts.js
 * ==============================================================
 * Applies LinkedIn account-liveness results to the `linkedin_profile` records
 * in src/_data/iocs/scraped-iocs.json, mirroring what
 * enrich-github-accounts.js does for GitHub.
 *
 * Run:
 *   node scripts/enrich-linkedin-accounts.js
 *
 * WHY THIS SCRIPT TAKES A RESULTS FILE INSTEAD OF FETCHING
 * -------------------------------------------------------
 * The GitHub script can check accounts itself because github.com/<login>
 * answers anonymously. LinkedIn does not: an anonymous request returns
 * HTTP 999 and an authwall, so liveness cannot be determined from CI or from a
 * plain fetch. The check has to run inside a signed-in browser session, which
 * is a manual step. This script is therefore the deterministic half — it takes
 * the observations that step produced and writes them into the dataset, so the
 * dataset edit stays reviewable in a pull request diff.
 *
 * HOW THE RESULTS IN data/linkedin-account-status.json WERE OBTAINED
 * -----------------------------------------------------------------
 * Each profile was loaded in a hidden iframe in a signed-in browser and the
 * iframe's final URL read. LinkedIn redirects a removed profile to /404/, so a
 * final URL still on /in/<slug>/ means live and a redirect to /404/ means gone.
 * Profile photos were downscaled to 128px in-page before being saved.
 *
 * The session used LinkedIn's Private mode, so viewing a profile does not
 * notify its owner.
 *
 * THE OPTIONAL `profile` BLOCK
 * ----------------------------
 * An account still up has more on it than the fact that it exists: a headline,
 * a location, a claimed employment history. Where that was read from a live
 * profile it travels in the results file as a `profile` object on the account
 * and is copied onto the record verbatim, for the persona pages to render:
 *
 *   { name, headline, current_role, location, connections, followers,
 *     about, observed,
 *     joined, contact_info_updated, photo_updated, verifications,
 *     experience: [{ title, organization, location, dates, summary }],
 *     education:  [{ institution, programme, dates, note }],
 *     education_count, project_count, skill_count,
 *     projects:     [{ name, dates, summary }],
 *     publications: [{ title, published_in, date }],
 *     licenses:     [{ name, issuer, dates }],
 *     languages: [], skills: [], top_skills: [],
 *     open_to_work, no_experience_section, backfilled }
 *
 * The sections below the fold were added on 2026-09-12, because the first pass
 * recorded only what the top of a profile showed and that is not where the
 * useful detail is. One account listed a 2015 IEEE paper on UCAV path planning
 * under a Beihang degree; another listed languages as Chinese native and English
 * professional working; a third listed a certificate-issuing Ethereum contract
 * written for a Lagos developer programme. None of it was in the dataset.
 *
 * LinkedIn renders those sections only as they scroll into view, which is why
 * the first pass missed them: a profile read without scrolling looks like a
 * profile with no experience. `no_experience_section` is set only where the page
 * was scrolled to the end and the section genuinely is not there.
 *
 * `backfilled` marks an account that gained an employment history AFTER it was
 * first recorded as having none. levente-bajusz-15329b368 had no roles and no
 * education on 31 August 2026 and, on 12 September, eleven years of both — on an
 * account LinkedIn dates to May 2025.
 *
 * The last four come from the "About this member" panel behind the profile's
 * More menu, which is the one part of a LinkedIn profile that is NOT the
 * account's own claim about itself: LinkedIn states there when the account was
 * created, how recently its contact details and photo were last changed, and
 * whether its identity has been verified against a government ID. A join date
 * years later than the employment history the profile claims is the single
 * most useful fact on the page, so it is read for every live account.
 *
 * Every field is optional, and nothing is synthesized to fill a gap: a row the
 * panel omits, or a field the profile leaves blank, is simply absent and the
 * pages render around it.
 *
 * ALL OF IT IS A CLAIM, NOT A FACT. It is what the operator wrote about a
 * person who does not exist. The pages label it as such; do not restate any of
 * it as biography.
 *
 * A `profile` block is only meaningful on a live account, so one attached to a
 * removed account is dropped rather than written — a removed profile cannot be
 * re-read, which makes such a block unfalsifiable against its own source.
 *
 * WHAT A PHOTO IS AND IS NOT
 * --------------------------
 * It is the picture the account presents. It is NOT evidence of who operates
 * the account: DPRK IT-worker personas routinely use stock imagery or photos
 * taken from uninvolved real people. That caveat is rendered next to every one.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { safeDecode } = require("./lib/ioc-normalize.js");

/** Prints the header comment's opening paragraph and exits 0, for --help/-h. */
function printHelp() {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  if (!m) return;
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  let bannerAt = -1;
  for (let j = 0; j < Math.min(lines.length, 6); j++) {
    if (/^=+$/.test(lines[j].trim())) { bannerAt = j; break; }
  }
  let i = bannerAt === -1 ? 0 : bannerAt + 1;
  while (lines[i] !== undefined && !lines[i].trim()) i++;
  const para = [];
  while (lines[i] !== undefined && lines[i].trim()) { para.push(lines[i]); i++; }
  console.log(para.join(" ").replace(/\s+/g, " ").trim());
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "src", "_data", "iocs", "scraped-iocs.json");
const RESULTS_PATH = path.join(__dirname, "data", "linkedin-account-status.json");
const PHOTO_DIR = path.join(ROOT, "src", "assets", "img", "linkedin");
const PHOTO_URL_BASE = "/assets/img/linkedin";

function slugOf(value) {
  return safeDecode(String(value).split("/").filter(Boolean).pop()).toLowerCase();
}

// The results file's own `slug` field becomes a photo filename below
// (`${observed.slug}.jpg`), and while that file is produced by the manual
// review step rather than fetched live, it is still an external input this
// script did not generate itself — validated the same way a fetched login or
// id would be, before it is used in a path.
const LINKEDIN_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;

function safeSlug(slug) {
  return typeof slug === "string" && LINKEDIN_SLUG_PATTERN.test(slug) ? slug : null;
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
  const bySlug = new Map(results.accounts.map((a) => [a.slug.toLowerCase(), a]));

  const records = data.records.filter((record) => record.ioc_type === "linkedin_profile");
  let live = 0;
  let removed = 0;
  let photos = 0;
  let detailed = 0;
  const unmatched = [];

  for (const record of records) {
    const observed = bySlug.get(slugOf(record.value));
    if (!observed) {
      unmatched.push(record.value);
      continue;
    }
    const slug = safeSlug(observed.slug);
    if (!slug) {
      console.error(`  skipping observation with invalid slug: ${JSON.stringify(observed.slug)}`);
      unmatched.push(record.value);
      continue;
    }
    // Only claim a photo the repository actually holds; a results file naming a
    // file that was never saved would render a broken image.
    const filename = `${slug}.jpg`;
    const hasPhoto =
      observed.state === "live" && fs.existsSync(path.join(PHOTO_DIR, filename));
    const hasProfile = observed.state === "live" && observed.profile;
    record.account_status = {
      state: observed.state,
      // An account added between sweeps carries its own date. The file-level
      // `checked` says when the last full sweep ran, and applying it to an
      // account checked on a different day would publish a date that is simply
      // wrong — the page states this as an observation, not as a file version.
      checked: observed.checked || results.checked,
      avatar: hasPhoto ? `${PHOTO_URL_BASE}/${filename}` : null,
    };
    if (hasProfile) record.account_status.profile = observed.profile;
    if (observed.state === "live") live += 1;
    if (observed.state === "removed") removed += 1;
    if (hasPhoto) photos += 1;
    if (hasProfile) detailed += 1;
  }

  data.generated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileAtomic(DATA_PATH, JSON.stringify(data, null, 2) + "\n");

  console.log(`${records.length} LinkedIn record(s): ${live} live, ${removed} removed.`);
  console.log(`Photos mirrored: ${photos}`);
  console.log(`Profile detail attached: ${detailed}`);
  if (unmatched.length) {
    console.log(`No observation for ${unmatched.length}:\n  ${unmatched.join("\n  ")}`);
  }
  console.log(`CHANGED=${live + removed > 0}`);
}

try {
  main();
} catch (err) {
  console.error("Enrichment failed:", err.message);
  console.log("CHANGED=false");
  process.exitCode = 1;
}
