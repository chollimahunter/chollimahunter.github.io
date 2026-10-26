#!/usr/bin/env node
/**
 * ingest-scraped-iocs.js
 * ==============================================================
 * Merges the run files staged in _drafts/iocs/ by scripts/scrape-dprk-iocs.js
 * into src/_data/iocs/scraped-iocs.json, which is what the site renders.
 *
 * Does no network access at all — it is a pure function of the staged files
 * and the existing dataset, so its diff is the thing a human reviews in the
 * pull request the weekly workflow opens.
 *
 * Run manually:
 *   node scripts/ingest-scraped-iocs.js
 *
 * Prints "CHANGED=true"/"CHANGED=false" as its last line of stdout.
 *
 * GROUNDING
 * ---------
 * Every extracted value must appear literally in the page text captured with
 * the run that claims it. A value that fails is REJECTED, not flagged: an
 * indicator absent from its own cited source has no citation, and an uncited
 * claim about a real person is the one thing this site's methodology exists to
 * prevent (see CONTENT_GUIDE.md). Regex extraction passes this by
 * construction; the check exists for any future model-assisted extraction,
 * where a fabricated but well-formed address with an invented supporting quote
 * would otherwise be indistinguishable from a real finding.
 */

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { decodeEntities, stripCfEmailPlaceholder } = require("./lib/html-entities.js");
const { seal } = require("./lib/private-data.js");

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

const {
  recordId,
  PLATFORM_ACCOUNTS,
  isExcludedEmail,
  normalizeIpv4,
  canonicalMailbox,
  EMAIL_PATTERN,
  hostOf,
  safeDecode,
} = require("./lib/ioc-normalize.js");
const { compareText } = require("./lib/compare.js");

/** Types whose stored value is a canonical URL rather than the literal text. */
const URL_SHAPED_TYPES = new Set([
  "github_profile",
  "linkedin_profile",
  ...PLATFORM_ACCOUNTS.map((spec) => spec.ioc_type),
]);

const ROOT = path.join(__dirname, "..");
const STAGING_DIR = path.join(ROOT, "_drafts", "iocs");
const DATA_PATH = path.join(ROOT, "src", "_data", "iocs", "scraped-iocs.json");

/**
 * The substring that must be present in the source text for a value to count
 * as grounded. A normalized URL is not itself expected to appear verbatim —
 * the page may have written github.com/User/Repo for what normalizes to
 * github.com/user — so for URL-shaped indicators the identifying segment is
 * what gets checked.
 */
function groundingToken(record) {
  // Every URL-shaped account type grounds on its handle. The normalized value
  // carries a scheme and a canonical host the page need not have written —
  // a report saying `t.me/handle` would fail a check against
  // `https://t.me/handle` and the record would be dropped as ungrounded.
  if (URL_SHAPED_TYPES.has(record.ioc_type)) {
    return safeDecode(record.value.split("/").filter(Boolean).pop());
  }
  // A payload URL is grounded on everything after the scheme, since the page
  // need not have written the scheme the stored value carries.
  if (record.ioc_type === "payload_url") return record.value.replace(/^https?:\/\//i, "");
  return record.value;
}

function loadStagedRuns() {
  if (!fs.existsSync(STAGING_DIR)) return [];
  return fs
    .readdirSync(STAGING_DIR)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .sort()
    .map((name) => ({
      name,
      run: JSON.parse(fs.readFileSync(path.join(STAGING_DIR, name), "utf8")),
    }));
}

const SOURCES_PATH = path.join(ROOT, "src", "_data", "iocs", "scrape-sources.json");
const SOURCE_DATES_PATH = path.join(__dirname, "data", "source-dates.json");

function loadCuratedDates() {
  if (!fs.existsSync(SOURCE_DATES_PATH)) return {};
  return JSON.parse(fs.readFileSync(SOURCE_DATES_PATH, "utf8")).dates || {};
}

/**
 * The hosts a publisher's own address would sit on, which is what
 * isExcludedEmail needs to recognise one. Built from scrape-sources.json
 * exactly as scrape-dprk-iocs.js builds it, so the two agree.
 */
function loadExcludedHosts() {
  if (!fs.existsSync(SOURCES_PATH)) return [];
  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  return (config.sources || []).map((entry) => hostOf(entry.url)).filter(Boolean);
}

/**
 * Values a source names that are not indicators, keyed by source URL. The
 * scraper drops these at extraction (see dropExcludedValues there); this is
 * the same list so the merged set obeys it too, for a value excluded after
 * the run that carried it was ingested.
 */
/**
 * The campaign label a source carries in scrape-sources.json, keyed by URL.
 *
 * scrape-dprk-iocs.js --source takes a bare URL and writes a run whose
 * source.campaign is empty, so a source labelled in the config after its run
 * was staged would otherwise ingest unlabelled. The config is the source of
 * truth for the label; the run's own campaign is the fallback for anything not
 * in the config yet.
 */
function loadSourceCampaigns() {
  if (!fs.existsSync(SOURCES_PATH)) return new Map();
  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const byUrl = new Map();
  for (const entry of config.sources || []) {
    if (entry.campaign && entry.campaign.length) byUrl.set(entry.url, entry.campaign);
  }
  return byUrl;
}

function loadExcludedValues() {
  if (!fs.existsSync(SOURCES_PATH)) return new Map();
  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const byUrl = new Map();
  for (const entry of config.sources || []) {
    if (!entry.exclude || !entry.exclude.length) continue;
    byUrl.set(entry.url, new Set(entry.exclude.map((item) => item.sealed)));
  }
  return byUrl;
}

/**
 * Sources that were read and then declined.
 *
 * `--source` takes any URL, so a candidate can be scraped during triage,
 * leave a run file behind, and afterwards be recorded in `not_scraped[]`.
 * Nothing stopped that run from being ingested anyway: a victim's drained
 * treasury wallet went back into the index twice after being removed, from a
 * source this file had already declined. A decision recorded in
 * `not_scraped[]` now holds here too.
 */
function loadDeclinedSources() {
  if (!fs.existsSync(SOURCES_PATH)) return new Set();
  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  return new Set((config.not_scraped || []).map((entry) => entry.url));
}

/**
 * Sources that were indexed and then withdrawn, recorded in `not_scraped[]`
 * with reason "withdrawn".
 *
 * Declining a source stops future runs from it but leaves what it already
 * contributed in place, which is right for a page that simply has nothing
 * more to give. A page that should never have been read is different: the
 * ANY.RUN "malware trends" page for WannaCry is a live sandbox summary, and
 * the addresses on it are whatever the sandbox VMs connected to when the
 * samples last ran -- GitHub, Google, Microsoft telemetry, Akamai -- each of
 * which was indexed under "Lazarus Group" on that page's sole authority, with
 * a fresh batch every week. A withdrawn source takes its citations with it on
 * every ingest, and a record left with none goes.
 */
function loadWithdrawnSources() {
  if (!fs.existsSync(SOURCES_PATH)) return new Set();
  const config = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  return new Set(
    (config.not_scraped || [])
      .filter((entry) => entry.reason === "withdrawn")
      .map((entry) => entry.url)
  );
}

function isExcludedFor(excludedValues, url, value) {
  const values = excludedValues.get(url);
  if (!values) return false;
  const lower = String(value).toLowerCase();
  // Compared by mailbox as well as literally, so an exclusion written against
  // the dotted address a report printed still catches the record, which stores
  // the mailbox that address reaches. Without this, canonicalizing Gmail would
  // have quietly switched off five standing exclusions.
  return values.has(seal(lower)) || values.has(seal(canonicalMailbox(lower)));
}

/**
 * Values judged to be false positives, dropped whoever published them.
 *
 * Distinct from the per-source `exclude` lists above in both effect and
 * visibility. An `exclude` entry says "this source printed a value that is not
 * an indicator" and drops that source's citation only. This list says "this
 * value is somebody else, and no source's say-so changes that" and applies
 * across every source.
 *
 * Both lists are sealed: the public files carry only a hash of each value
 * (scripts/lib/private-data.js), because a withheld value usually belongs to
 * an uninvolved person, and publishing it beside the reason it was dropped
 * would name them as surely as indexing it would.
 */
const FALSE_POSITIVE_PATH = path.join(__dirname, "data", "false-positives.json");

function loadFalsePositives() {
  if (!fs.existsSync(FALSE_POSITIVE_PATH)) return new Set();
  const doc = JSON.parse(fs.readFileSync(FALSE_POSITIVE_PATH, "utf8"));
  return new Set((doc.values || []).map((entry) => entry.sealed));
}

function loadExisting() {
  if (!fs.existsSync(DATA_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  return parsed.records || [];
}

/**
 * Identity of one sighting: the document it came from plus the passage quoted.
 *
 * JSON-encoded rather than joined on a separator character. This previously
 * concatenated the two around a literal NUL, which git then treated as a binary
 * file -- every change to this file showed as "Binary files differ" instead of a
 * diff, so edits here could not be reviewed as text.
 *
 * Compared decoded, so a citation stored before titles, URLs and quotes were
 * decoded at extraction still matches the same sighting read again.
 */
function sourceKey(source) {
  return JSON.stringify([decodeEntities(source.url), stripCfEmailPlaceholder(source.context || "")]);
}

function mergeInto(byId, incoming, stats) {
  const existing = byId.get(incoming.id);
  if (!existing) {
    byId.set(incoming.id, incoming);
    return "added";
  }

  // A sighting already held keeps its place, but its CITATION is refreshed from
  // the incoming run. The run file is a newer read of the same document, so
  // where the two disagree about the title, publisher, date or hash, the fresh
  // read is the better one and the stored copy is stale.
  //
  // Without this a citation could never be corrected. DOJ serves its forfeiture
  // complaint from a path ending `/dl`, which the PDF title fallback rendered as
  // the title "dl" on every indicator drawn from it; giving the source a proper
  // title in scrape-sources.json changed nothing, because re-ingesting only ever
  // added sources it had not seen and left the 22 existing ones alone.
  //
  // Only the fields that describe the DOCUMENT are refreshed. The ones that
  // describe this particular sighting — context, section, pulled_at — are left
  // as they were captured.
  //
  // That split matters, because the staging directory holds runs taken on
  // different days and in different versions of the extractor, and the newest
  // is not automatically the best. Refreshing `section` too pulled headings
  // backwards, rewriting a stored "The Mysterious Case of NetKey" to the
  // "# The Mysterious Case of NetKey" an older run had captured before the
  // heading cleanup existed. Refreshing `pulled_at` churned every source read
  // by more than one staged run, with the winner decided by filename order.
  const byKey = new Map(existing.sources.map((source) => [sourceKey(source), source]));
  for (const source of incoming.sources) {
    const key = sourceKey(source);
    const held = byKey.get(key);
    if (!held) {
      existing.sources.push(source);
      byKey.set(key, source);
      continue;
    }
    for (const field of ["url", "title", "publisher", "published"]) {
      if (source[field] !== undefined && source[field] !== null && source[field] !== held[field]) {
        held[field] = source[field];
        stats.refreshed += 1;
      }
    }
  }
  // An indicator reported under two clusters carries both labels.
  for (const campaign of incoming.campaign || []) {
    if (!existing.campaign.includes(campaign)) existing.campaign.push(campaign);
  }
  if (incoming.first_seen < existing.first_seen) existing.first_seen = incoming.first_seen;
  if (incoming.last_seen > existing.last_seen) existing.last_seen = incoming.last_seen;
  if (!existing.display && incoming.display) existing.display = incoming.display;
  if (!existing.persona && incoming.persona) existing.persona = incoming.persona;
  return "merged";
}

function main() {
  const staged = loadStagedRuns();
  if (!staged.length) {
    console.log("No staged runs in _drafts/iocs/. Nothing to ingest.");
    console.log("CHANGED=false");
    return;
  }

  const existingRecords = loadExisting();
  const existingShape = JSON.stringify(existingRecords);
  const before = new Set(existingRecords.map((record) => record.id));
  const byId = new Map(existingRecords.map((record) => [record.id, record]));

  let rejected = 0;
  let ingested = 0;
  // Counted here rather than at module scope so a second main() in one
  // process cannot inherit the first run's tally.
  const stats = { refreshed: 0 };
  let declined = 0;
  const excludedValues = loadExcludedValues();
  const declinedSources = loadDeclinedSources();
  const sourceCampaigns = loadSourceCampaigns();

  for (const { name, run } of staged) {
    if (declinedSources.has(run.source.url)) {
      declined += 1;
      continue;
    }
    const sourceText = (run.source_text || "").toLowerCase();
    const sourceDigits = sourceText.replace(/\D/g, "");
    // The same text with every Gmail address reduced to the mailbox it reaches,
    // because that is the form the record now stores. A report printing
    // "a.l.l.a.nh.orca0.7@googlemail.com" grounds the record for
    // allanhorca07@gmail.com: it is the same mailbox, and a literal check
    // against the stored value would reject a value the source plainly carries.
    // See canonicalMailbox in scripts/lib/ioc-normalize.js.
    const sourceTextByMailbox = sourceText.replace(EMAIL_PATTERN, (match) =>
      canonicalMailbox(match.toLowerCase())
    );
    const method = run.extraction?.method || "regex";

    for (const artifact of run.artifacts || []) {
      if (isExcludedFor(excludedValues, run.source.url, artifact.value)) {
        rejected += 1;
        continue;
      }
      // Re-apply the email denylist at merge time. The scraper applies it when
      // a run is created, but a domain added to the denylist afterwards --
      // genians.com, us-cert.gov -- would otherwise stay in the index via the
      // runs staged before the change, until every source was re-scraped.
      // Applying it here retires a vendor or government address everywhere at
      // once. Guarded to email so nothing else changes.
      if (artifact.ioc_type === "email_address" && isExcludedEmail(artifact.value, {})) {
        rejected += 1;
        continue;
      }
      // An address is stored as the mailbox it reaches. The scraper canonicalizes
      // at extraction, but a run staged before that rule existed still carries
      // the dotted form, and taking it as written would file the same mailbox
      // twice — which is exactly what the rule exists to prevent. The
      // as-published form is kept as `display` so the page can still show what
      // the report printed.
      const value =
        artifact.ioc_type === "email_address"
          ? canonicalMailbox(String(artifact.value).toLowerCase())
          : artifact.value;
      const record = {
        id: recordId(artifact.ioc_type, value),
        ioc_type: artifact.ioc_type,
        value,
        display: artifact.display || (value !== artifact.value ? artifact.value : null),
        persona: artifact.persona || null,
        campaign: sourceCampaigns.get(run.source.url) || run.source.campaign || [],
        // When the report was published, not when this tool happened to read
        // it. "First seen 2026-08-30" on a 2026-04-08 Group-IB article says
        // nothing useful about the indicator; the publication date is what
        // tells a reader how current the reporting is. The pull date is kept
        // per source and shown separately.
        first_seen: run.source.published || run.source.pulled_at,
        last_seen: run.source.published || run.source.pulled_at,
        extraction: {
          method,
          model: run.extraction?.model || null,
          grounded: true,
        },
        sources: [
          {
            // A run staged before extraction decoded entities still carries
            // them; see scripts/lib/html-entities.js.
            url: decodeEntities(run.source.url),
            title: decodeEntities(run.source.title),
            publisher: run.source.publisher || null,
            published: run.source.published || null,
            // Kept for every origin, not just prose. An appendix window is
            // not a sentence, but it is the evidence a reviewer needs; the
            // origin below tells the page how to present it.
            context: stripCfEmailPlaceholder(artifact.context || ""),
            context_origin: artifact.context_origin || "text",
            // Where in the report it sat. For an appendix-table sighting there
            // is no sentence to quote, so this is the only locator there is.
            section: artifact.section || null,
            pulled_at: run.source.pulled_at,
            source_sha256: run.source.source_sha256 || null,
          },
        ],
      };

      const token = groundingToken(record).toLowerCase();
      // A telephone number is stored as E.164 and the page printed it however
      // it liked, so it is grounded on its last nine digits against the
      // page's digits with every separator removed.
      const grounded =
        record.ioc_type === "phone_number"
          ? sourceDigits.includes(record.value.replace(/\D/g, "").slice(-9))
          : sourceText.includes(token) || sourceTextByMailbox.includes(token);
      if (!grounded) {
        rejected += 1;
        console.error(
          `  REJECTED (ungrounded) ${record.ioc_type} ${record.value} — not present in ${name}`
        );
        continue;
      }

      mergeInto(byId, record, stats);
      ingested += 1;
    }
  }

  // An exclusion rule added after a value shipped has to be able to reach it.
  //
  // Extraction rules only gate what enters a run file, so a rule written today
  // stops tomorrow's harvest and leaves yesterday's records in place. Two
  // researchers' own contact addresses were sitting in the published index for
  // exactly that reason -- chollima_group@proton.me from "feel free to contact
  // us at", dprk-research@pm.me from "Want to get in touch?" -- each harvested
  // before the rule that now recognises a publisher's own address existed.
  //
  // Re-applied on every ingest, so the merged set always satisfies the current
  // rules rather than whichever ones were in force when each value arrived.
  // Only value-based exclusions can run here: a context guard needs the source
  // text around the match, which a stored record does not carry.
  // A publication date checked by hand, with its evidence, in
  // scripts/data/source-dates.json beats the one the extractor read. The
  // citation refresh above takes whatever date the newest run found, and a
  // recheck can find a wrong one: a Wayback copy of IronNet's 2022 NOC write-up
  // extracted as 2026-05-13. Only a full date: a citation's `published` is
  // YYYY-MM-DD, and a month-only curated date stays on the sources page.
  const curatedDates = loadCuratedDates();
  for (const record of byId.values()) {
    for (const source of record.sources) {
      const curated = curatedDates[source.url];
      if (curated && /^\d{4}-\d{2}-\d{2}$/.test(curated.date || "")) source.published = curated.date;
    }
  }

  // Sightings stored with the quote blanked, under the rule that once kept
  // passwords out of quotes, give way to a later read of the same source that
  // carries the quote, rather than sitting beside it as a second citation.
  for (const record of byId.values()) {
    const quoted = new Set(
      record.sources.filter((s) => s.context_origin !== "redacted").map((s) => s.url)
    );
    record.sources = record.sources.filter(
      (s) => s.context_origin !== "redacted" || !quoted.has(s.url)
    );
  }

  const excludedHosts = loadExcludedHosts();
  const falsePositives = loadFalsePositives();
  const withdrawnSources = loadWithdrawnSources();
  const pruned = [];
  const kept = [...byId.values()].filter((record) => {
    // A false positive goes whoever published it, and takes every citation with
    // it: the judgement is about the value, not about one source's reading.
    if (falsePositives.has(seal(record.value))) {
      pruned.push(record);
      return false;
    }
    // A per-source exclusion removes that source's citation and nothing else:
    // the same value cited by a second source keeps the record on the second
    // source's authority.
    if (excludedValues.size || withdrawnSources.size) {
      record.sources = record.sources.filter(
        (source) =>
          !withdrawnSources.has(source.url) &&
          !isExcludedFor(excludedValues, source.url, record.value)
      );
      if (!record.sources.length) {
        pruned.push(record);
        return false;
      }
    }
    // An address that the current rules would not accept today. normalizeIpv4 is
    // a pure function of the value, so it can be re-applied to a stored record
    // the way the email rules above are: the version-number, public-resolver and
    // CDN-edge rules were written after those values shipped, and without this
    // they would only have gated future runs. 1.1.1.1 would have stayed.
    if (record.ioc_type === "ip_address" && !normalizeIpv4(record.value)) {
      pruned.push(record);
      return false;
    }
    if (record.ioc_type !== "email_address") return true;
    if (!isExcludedEmail(record.value, { excludedHosts })) return true;
    pruned.push(record);
    return false;
  });

  // Locale pinned rather than left to the runtime default: this order is
  // baked into the committed data file, and an unpinned localeCompare's
  // collation depends on the environment, which the author's Windows machine
  // and the Ubuntu CI runner are not guaranteed to agree on.
  const records = kept.sort(
    (a, b) => compareText(a.ioc_type, b.ioc_type) || compareText(a.value, b.value)
  );

  const added = records.filter((record) => !before.has(record.id));
  // Decided by comparing the result to what was loaded, not by counting the
  // writes that produced it. Two staged runs can read the same source on
  // different days and disagree about its publication date, so the citation
  // refresh rewrites that field on every run while leaving the file identical.
  // Counting refreshes reported CHANGED=true forever, and the weekly workflow
  // opens a pull request on that flag.
  const changed = JSON.stringify(records) !== existingShape;

  // The whole file is rewritten rather than patched, so record_count can never
  // drift from records.length — the same discipline sync-dtex-itworker-emails.js
  // uses to keep entry_count honest.
  const output = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    record_count: records.length,
    records,
  };
  writeFileAtomic(DATA_PATH, JSON.stringify(output, null, 2) + "\n");

  console.log(
    `Ingested ${ingested} indicator sighting(s) from ${staged.length} staged run(s).`
  );
  console.log(
    `Added: ${added.length}, total records: ${records.length}, rejected: ${rejected}, ` +
      `citation fields refreshed: ${stats.refreshed}`
  );
  if (pruned.length) {
    console.log(
      "Pruned by current exclusion rules:\n" +
        pruned.map((record) => `  - ${record.ioc_type} ${record.value}`).join("\n")
    );
  }
  if (added.length) {
    console.log(
      "New indicators:\n" +
        added.map((record) => `  + ${record.ioc_type} ${record.value}`).join("\n")
    );
  }
  console.log(`CHANGED=${changed}`);
}

try {
  main();
} catch (err) {
  console.error("Ingest failed:", err.message);
  console.log("CHANGED=false");
  process.exitCode = 1;
}
