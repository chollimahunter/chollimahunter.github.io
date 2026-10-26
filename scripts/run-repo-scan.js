#!/usr/bin/env node
/**
 * run-repo-scan.js
 * ==============================================================
 * Runs the six-step procedure documented in docs/repo-scanner-github-scan.md:
 * turns every searchable entry in repo-scan-ruleset.json into a GitHub
 * code-search query, runs them, and writes the result to
 * src/_data/scanResults/latest.json (and appends a summary to
 * src/_data/scanResults/history.json, which the results page renders as a
 * run-history table).
 *
 * Run manually:
 *   node scripts/run-repo-scan.js --dry-run              # build queries, call nothing
 *   GITHUB_TOKEN=ghp_xxx node scripts/run-repo-scan.js    # live run, full ruleset
 *   node scripts/run-repo-scan.js --token ghp_xxx --limit 20   # live, first 20 queries only
 *   node scripts/run-repo-scan.js --gh                   # live, authenticated through the gh CLI
 *   node scripts/run-repo-scan.js --gh --reverify src/_data/scanResults/latest.json
 *                                                        # exact-dependency check of an existing results file
 *
 * A full live run is about 1,400 queries and six hours. Progress is saved to
 * _drafts/repo-scan/checkpoint.json before every query, and a run over the
 * same ruleset picks up where an interrupted one stopped (--fresh ignores it).
 * Without this, two full runs were lost to the machine sleeping, with nothing
 * written. A run stopped early by rate limiting keeps its checkpoint and does
 * not overwrite latest.json, so rerunning later finishes it.
 *
 * Prints "CHANGED=true"/"CHANGED=false" as its last line, same contract as
 * scripts/sync-dtex-itworker-emails.js and scripts/check-etherhiding-contracts.js.
 *
 * WHAT A MATCH MEANS
 * -------------------
 * That a repository's code contains a string GitHub's search index matched
 * against a known indicator. It is a lead for manual review, never a
 * finding -- see docs/repo-scanner-github-scan.md Step 6. This tool makes
 * no judgment about the matched repository or its owner.
 *
 * RULES THIS TOOL MUST NOT BEND
 * --------------------------------
 * Never executes a matched file. The search API's own metadata (path, repo,
 * URL) is what gets recorded; for an npm or PyPI package rule the matched
 * manifest is also downloaded as plain text and parsed as data, only to check
 * that the package is a real dependency and not a substring of another
 * package's name (scripts/lib/dependency-match.js). Its contents are not
 * stored. A query that fails or hits a rate limit is recorded as a
 * failure in queries_executed, never silently dropped or retried into a
 * fabricated success. No token is bundled with this repository -- live
 * mode does nothing without one supplied at run time.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFile } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { scanMatchKind } = require("./lib/scan-match-kind.js");
const { parseBlobUrl, declaresPackage } = require("./lib/dependency-match.js");
const { containsToken, isTokenType, needsText } = require("./lib/token-match.js");

const ROOT = path.join(__dirname, "..");
const RULESET_PATH = path.join(ROOT, "src", "_data", "iocs", "repo-scan-ruleset.json");
const LATEST_PATH = path.join(ROOT, "src", "_data", "scanResults", "latest.json");
const HISTORY_PATH = path.join(ROOT, "src", "_data", "scanResults", "history.json");
const CHECKPOINT_PATH = path.join(ROOT, "_drafts", "repo-scan", "checkpoint.json");
const VERDICT_CACHE_PATH = path.join(ROOT, "_drafts", "repo-scan", "verdicts.json");

// GitHub's docs advertise 30/min for authenticated code search, but a real
// run hit a 403 after 11 queries at 2.1s spacing -- the actual limit runs
// closer to 10/min in practice. Paced accordingly; MAX_RATE_LIMIT_WAITS_TOTAL
// below still absorbs whatever gap remains between this and reality.
/**
 * The owner whose repositories a scan never reports on: this site's own.
 * SCAN_SELF_OWNER overrides it for anyone running the tool from a fork.
 */
const OWN_OWNER = (process.env.SCAN_SELF_OWNER || "chollimahunter").toLowerCase();

function isOwnRepository(fullName) {
  if (!fullName) return false;
  return fullName.toLowerCase().startsWith(OWN_OWNER + "/");
}

const REQUEST_DELAY_MS = 6500;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MATCHES_PER_QUERY = 10; // caps a single broad query from flooding the results file
const MAX_HISTORY_RUNS = 20;

// ---------------------------------------------------------------------------
// Step 1 — load the ruleset
// ---------------------------------------------------------------------------

function loadRuleset() {
  const entries = JSON.parse(fs.readFileSync(RULESET_PATH, "utf8"));
  if (!Array.isArray(entries)) throw new Error("repo-scan-ruleset.json must be a JSON array");
  const latestDate = entries.reduce((max, e) => (e.date_added > max ? e.date_added : max), "");
  return { entries, version: `repo-scan-ruleset.json @ ${latestDate} (${entries.length} entries)` };
}

// ---------------------------------------------------------------------------
// Step 2 — derive queries, per docs/repo-scanner-github-scan.md's table
// ---------------------------------------------------------------------------

function derive(entry) {
  // A filename that is also an ordinary name elsewhere (p.zi matches every
  // Zig source file, systemd-resolved is a real daemon, config.bat is a
  // common batch file) returns thousands of unrelated repositories and buries
  // the real matches, so an entry can opt its value out of code search while
  // staying in the ruleset for the local signature check.
  if (entry.github_search === false) return [];
  const v = entry.value;
  switch (entry.ioc_type) {
    case "github_dork":
      return [v];
    case "npm_package":
      return [`"${v}" filename:package.json`, `"${v}" filename:package-lock.json`];
    case "pypi_package":
      return [`"${v}" filename:requirements.txt`, `"${v}" filename:pyproject.toml`];
    case "filename":
      // A value listing several names is written "a.dmg / b.msi" with spaces
      // around the slash; a bare slash is a path (vendor/run-update.sh) and
      // must not be split, or the directory name becomes its own query
      // (filename:vendor returned 1.7 million results).
      return v.split(" / ").map((part) => `filename:${part.trim()}`);
    case "domain":
    case "wallet_address":
    case "ip_address":
      return [`"${v}"`];
    default:
      // c2_pattern and anything else: not GitHub-searchable, per the doc.
      return [];
  }
}

function buildQueries(entries) {
  const queries = [];
  for (const entry of entries) {
    for (const q of derive(entry)) {
      queries.push({ entry, query: q });
    }
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Step 3 — run the searches
// ---------------------------------------------------------------------------

// Stands in for a token when --gh is given: each search goes through
// `gh api`, which authenticates from the gh CLI's own login, so no token
// value is ever read into this process or passed on a command line.
const GH_CLI = Symbol("gh-cli");

function searchCodeViaGh(query) {
  const result = spawnSync(
    "gh",
    ["api", "-X", "GET", "search/code", "-f", `q=${query}`, "-f", `per_page=${MAX_MATCHES_PER_QUERY}`],
    { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }
  );
  if (result.error) throw new Error(`gh api failed: ${result.error.message}`);
  if (result.status === 0) return JSON.parse(result.stdout);
  const stderr = result.stderr || "";
  if (/HTTP (403|429)|rate limit/i.test(stderr)) throw new RateLimitError(null);
  throw new Error(stderr.trim().split(/\r?\n/).pop() || `gh api exited ${result.status}`);
}

async function searchCode(query, token) {
  if (token === GH_CLI) return searchCodeViaGh(query);
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${MAX_MATCHES_PER_QUERY}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ChollimaHunterRepoScan/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 403 || response.status === 429) {
    const resetHeader = response.headers.get("x-ratelimit-reset");
    throw new RateLimitError(resetHeader ? new Date(Number(resetHeader) * 1000).toISOString() : null);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

class RateLimitError extends Error {
  constructor(resetAt) {
    super(`rate limited${resetAt ? `, resets ${resetAt}` : ""}`);
    this.resetAt = resetAt;
  }
}

/**
 * GitHub's actual code-search rate limit runs stricter than the 30/min the
 * REST docs advertise for authenticated requests -- a live run hit it after
 * 11 queries at 2.1s spacing. Rather than aborting the whole run at the
 * first 403/429 (which used to mean queries 12-169 were silently never
 * attempted), each rate limit is waited out using the `x-ratelimit-reset`
 * header GitHub actually returns, and the same query is retried -- capped
 * so a persistently bad token/query can't hang the run forever.
 */
// At least 15, and one more for every 40 queries, so a run over the full
// ruleset is not cut short by a budget sized for a much smaller one.
const MAX_RATE_LIMIT_WAITS_FLOOR = 15;
const QUERIES_PER_EXTRA_WAIT = 40;
const MAX_RATE_LIMIT_RETRIES_PER_QUERY = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 65000;
const RATE_LIMIT_WAIT_BUFFER_MS = 3000;

// ---------------------------------------------------------------------------
// Exact-dependency verification
// ---------------------------------------------------------------------------
//
// Code search matches substrings, so a rule for the package "config-log" also
// returns projects that depend on "eslint-config-log-level". For npm and PyPI
// rules the matched manifest is fetched and a match is kept only when the
// package is declared there as a dependency under exactly that name.

const FETCH_SPACING_MS = 100;
const FETCH_CONCURRENCY = 4;
const MAX_FETCH_RETRIES = 4;
const NOTE_SUBSTRING_DROPPED = "substring matches dropped after exact-match check";
const NOTE_SUBSTRING_DROPPED_LEGACY = "substring matches dropped after exact-dependency check";
const NOTE_UNRETRIEVABLE_DROPPED = "matches dropped because the matched file could not be retrieved to verify";

class FetchPending extends Error {}

function isPackageRule(entry) {
  return entry.ioc_type === "npm_package" || entry.ioc_type === "pypi_package";
}

/** Package rules (exact dependency) and domain, IP, wallet and filename rules (exact token). */
function isVerifiableRule(entry) {
  return isPackageRule(entry) || isTokenType(entry.ioc_type);
}

/** Downloads one file at the commit the search matched. Returns { text } or { gone }. */
async function fetchMatchedFile(blob, token) {
  const endpoint = `repos/${blob.owner}/${blob.repo}/contents/${blob.path}?ref=${blob.ref}`;
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let detail = "";
    if (token === GH_CLI) {
      const r = await new Promise((resolve) => {
        execFile(
          "gh",
          ["api", "-H", "Accept: application/vnd.github.raw", endpoint],
          { encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ error, stdout, stderr })
        );
      });
      if (!r.error) return { text: r.stdout };
      if (r.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { gone: "file too large" };
      detail = ((r.stderr || "") + (r.error.killed ? " timed out" : "")).trim() || r.error.message;
      const m = /HTTP (\d{3})/.exec(detail);
      status = m ? Number(m[1]) : 0;
    } else {
      try {
        const response = await fetch(`https://api.github.com/${endpoint}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.raw",
            "User-Agent": "ChollimaHunterRepoScan/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(60000),
        });
        if (response.ok) return { text: await response.text() };
        status = response.status;
        detail = (await response.text()).slice(0, 200);
      } catch (err) {
        detail = err.message;
      }
    }
    if (status === 404 || status === 451 || status === 410) return { gone: `HTTP ${status}` };
    const rateLimited = status === 429 || (status === 403 && /rate limit|abuse|secondary|retry/i.test(detail));
    if (status === 403 && !rateLimited) return { gone: "HTTP 403" };
    if (attempt >= MAX_FETCH_RETRIES) throw new FetchPending(detail || `HTTP ${status}`);
    console.log(`  retry ${attempt + 1} for ${blob.owner}/${blob.repo}: HTTP ${status}${rateLimited ? " (rate limited)" : ""} ${detail.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, rateLimited ? DEFAULT_RATE_LIMIT_WAIT_MS * (attempt + 1) : 5000 * (attempt + 1)));
  }
}

/**
 * "keep", "drop" (the package is not declared there) or "unretrievable" (the
 * file is gone or blocked). Throws FetchPending for a failure worth retrying
 * on a later run, which is never treated as a verdict.
 */
async function verifyPackageMatch(entry, location, token) {
  const blob = parseBlobUrl(location);
  if (!blob) return "unretrievable";
  if (!isPackageRule(entry) && !needsText(entry.ioc_type)) {
    // A filename rule is decided by the matched path alone; nothing to fetch.
    return containsToken(entry.ioc_type, entry.value, "", blob.path) ? "keep" : "drop";
  }
  const file = await fetchMatchedFile(blob, token);
  await new Promise((r) => setTimeout(r, FETCH_SPACING_MS));
  if (file.gone) return "unretrievable";
  const ok = isPackageRule(entry)
    ? declaresPackage(entry.ioc_type, entry.value, file.text, blob.path)
    : containsToken(entry.ioc_type, entry.value, file.text, blob.path);
  return ok ? "keep" : "drop";
}

function loadVerdicts() {
  try {
    return JSON.parse(fs.readFileSync(VERDICT_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveVerdicts(verdicts) {
  fs.mkdirSync(path.dirname(VERDICT_CACHE_PATH), { recursive: true });
  writeFileAtomic(VERDICT_CACHE_PATH, JSON.stringify(verdicts) + "\n");
}

/** One queries_executed line per rule that lost matches, never silent. */
function dropNotes(dropped) {
  const lines = [];
  for (const [id, c] of Object.entries(dropped)) {
    if (c.substring) lines.push(`${id} -- ${c.substring} ${NOTE_SUBSTRING_DROPPED}`);
    if (c.unretrievable) lines.push(`${id} -- ${c.unretrievable} ${NOTE_UNRETRIEVABLE_DROPPED}`);
  }
  return lines;
}

function isDropNote(line) {
  return line.includes(NOTE_SUBSTRING_DROPPED) || line.includes(NOTE_SUBSTRING_DROPPED_LEGACY) || line.includes(NOTE_UNRETRIEVABLE_DROPPED);
}

/**
 * Applies the exact-dependency check to an existing results file without
 * searching again. Verdicts are cached per match location in
 * _drafts/repo-scan/verdicts.json, so an interrupted run resumes where it
 * stopped. Returns false (writing nothing) when some fetches are still pending.
 */
async function reverify(file, token) {
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  const { entries } = loadRuleset();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const verdicts = loadVerdicts();
  const before = result.matches.length;
  const kept = [];
  const dropped = {};
  let fetched = 0;
  let pending = 0;
  const targets = result.matches.filter((m) => byId.has(m.ioc_id) && isVerifiableRule(byId.get(m.ioc_id))).length;
  console.log(`Reverifying ${targets} package, domain, IP, wallet and filename match(es) of ${before}.`);

  // Fetch the uncached locations a few at a time; the verdict loop below then
  // only reads the cache (and retries whatever is still missing).
  const todo = [];
  for (const match of result.matches) {
    const entry = byId.get(match.ioc_id);
    if (entry && isVerifiableRule(entry) && !verdicts[`${entry.id}\t${match.location}`]) todo.push({ entry, match });
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { entry, match } = todo[next++];
      try {
        verdicts[`${entry.id}\t${match.location}`] = await verifyPackageMatch(entry, match.location, token);
      } catch (err) {
        console.log(`  pending: ${match.location} (${err.message})`);
      }
      if (++fetched % 50 === 0) {
        saveVerdicts(verdicts);
        console.log(`  ${fetched} of ${todo.length} fetched`);
      }
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  saveVerdicts(verdicts);

  for (const match of result.matches) {
    const entry = byId.get(match.ioc_id);
    if (!entry || !isVerifiableRule(entry)) {
      kept.push(match);
      continue;
    }
    const key = `${entry.id}\t${match.location}`;
    let verdict = verdicts[key];
    if (!verdict) {
      try {
        verdict = await verifyPackageMatch(entry, match.location, token);
      } catch (err) {
        pending++;
        kept.push(match);
        console.log(`  pending: ${match.location} (${err.message})`);
        continue;
      }
      verdicts[key] = verdict;
      if (++fetched % 25 === 0) {
        saveVerdicts(verdicts);
        console.log(`  ${fetched} fetched`);
      }
    }
    if (verdict === "keep") kept.push(match);
    else {
      const c = (dropped[entry.id] = dropped[entry.id] || { substring: 0, unretrievable: 0 });
      c[verdict === "drop" ? "substring" : "unretrievable"]++;
    }
  }
  saveVerdicts(verdicts);

  if (pending) {
    console.log(`${pending} match(es) could not be checked yet; ${path.basename(file)} was not changed. Run the same command again to finish.`);
    return false;
  }

  const droppedTotal = before - kept.length;
  result.matches = kept;
  const priorLines = result.queries_executed.filter((l) => !isDropNote(l));
  if (result.query_count === undefined) result.query_count = priorLines.length;
  result.queries_executed = priorLines.concat(dropNotes(dropped));
  result.status_note =
    result.status_note.replace(/ Exact-(dependency|match) check:.*$/, "") +
    ` Exact-match check: ${droppedTotal} of ${before} matches dropped because the package, domain, IP address, wallet or filename named by the rule is not present as a whole token (a declared dependency, for a package) in the matched file (code search matches substrings), leaving ${kept.length}.`;
  writeFileAtomic(file, JSON.stringify(result, null, 2) + "\n");

  const history = loadHistory();
  const latestEntry = history.find((h) => h.scan_id === result.scan_id);
  if (latestEntry) {
    latestEntry.match_count = kept.length;
    writeFileAtomic(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  }
  console.log(`Kept ${kept.length} of ${before} match(es); ${droppedTotal} dropped.`);
  return true;
}

async function runQueries(queries, token, { dryRun, verbose, resume = null, save = null }) {
  const matches = resume ? resume.matches : [];
  let skippedOwn = resume ? resume.skippedOwn : 0;
  const droppedByRule = {};
  const executed = resume ? resume.executed : [];
  let totalRateLimitWaits = 0;
  const maxWaitsTotal = Math.max(MAX_RATE_LIMIT_WAITS_FLOOR, Math.ceil(queries.length / QUERIES_PER_EXTRA_WAIT));

  for (let i = resume ? resume.done : 0; i < queries.length; i++) {
    const { entry, query } = queries[i];
    if (save) save({ done: i, matches, executed, skippedOwn });
    if (dryRun) {
      executed.push(`[dry-run, not sent] ${entry.id} -- ${query}`);
      continue;
    }

    let result = null;
    let queryRetries = 0;
    for (;;) {
      try {
        result = await searchCode(query, token);
        break;
      } catch (err) {
        if (!(err instanceof RateLimitError)) {
          executed.push(`${entry.id} -- [${query}] -- FAILED: ${err.message}`);
          await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
          break;
        }
        totalRateLimitWaits++;
        queryRetries++;
        if (totalRateLimitWaits > maxWaitsTotal || queryRetries > MAX_RATE_LIMIT_RETRIES_PER_QUERY) {
          executed.push(
            `${entry.id} -- [${query}] -- STOPPED: rate limited too many times to continue waiting it out${err.resetAt ? ` (last reset ${err.resetAt})` : ""}`
          );
          return { matches, executed, stoppedEarly: true, skippedOwn };
        }
        const waitMs = err.resetAt
          ? Math.max(RATE_LIMIT_WAIT_BUFFER_MS, new Date(err.resetAt).getTime() - Date.now() + RATE_LIMIT_WAIT_BUFFER_MS)
          : DEFAULT_RATE_LIMIT_WAIT_MS;
        const note = `rate limited on [${query}] -- waiting ${Math.round(waitMs / 1000)}s${err.resetAt ? ` (resets ${err.resetAt})` : ""}, then retrying`;
        executed.push(note);
        if (verbose) console.log(`  ${note}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    if (!result) continue;

    const total = result.total_count || 0;
    const items = result.items || [];
    executed.push(
      `${entry.id} -- [${query}] -- ${total} result(s)${
        total > items.length ? `, showing first ${items.length}` : ""
      }`
    );

    for (const item of items) {
      // This repository publishes the ruleset and the previous run's results,
      // so GitHub's index holds every indicator string this scan searches for
      // under our own owner. Left in, the site matches itself, and each run
      // writes a results file the next run then matches again. Skip our own
      // repositories rather than publish that as a finding.
      if (isOwnRepository(item.repository?.full_name)) {
        skippedOwn++;
        continue;
      }
      if (!dryRun && isVerifiableRule(entry)) {
        let verdict;
        try {
          verdict = await verifyPackageMatch(entry, item.html_url, token);
        } catch (err) {
          executed.push(`${entry.id} -- ${item.html_url} -- NOT VERIFIED (${err.message}), match dropped`);
          continue;
        }
        if (verdict !== "keep") {
          const c = (droppedByRule[entry.id] = droppedByRule[entry.id] || { substring: 0, unretrievable: 0 });
          c[verdict === "drop" ? "substring" : "unretrievable"]++;
          continue;
        }
      }
      const match = {
        ioc_id: entry.id,
        matched_value: entry.value,
        location: item.html_url,
        matched_at: new Date().toISOString(),
        context: `matched in ${item.repository?.full_name || "unknown repo"}, path ${item.path} (${entry.malware_family || "unattributed"}, indicator confidence ${entry.confidence_level || "unstated"})`,
        // "research" when the match's path and repository name look like
        // detection tooling or a published indicator list rather than a
        // possibly compromised project -- see scripts/lib/scan-match-kind.js
        // and docs/repo-scanner-github-scan.md. null otherwise.
        kind: scanMatchKind({ location: item.html_url }),
      };
      matches.push(match);
    }
    if (verbose) console.log(`  ${entry.id}: ${query} -> ${total} result(s)`);

    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  executed.push(...dropNotes(droppedByRule));
  return { matches, executed, stoppedEarly: false, skippedOwn };
}

/** Identifies the query list a checkpoint belongs to. */
function queriesFingerprint(queries) {
  const hash = crypto.createHash("sha256");
  for (const { entry, query } of queries) hash.update(`${entry.id}\t${query}\n`);
  return hash.digest("hex");
}

function loadCheckpoint(fingerprint) {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
    return saved.fingerprint === fingerprint ? saved : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(fingerprint, state) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  writeFileAtomic(CHECKPOINT_PATH, JSON.stringify({ fingerprint, saved_at: nowIso(), ...state }) + "\n");
}

// ---------------------------------------------------------------------------
// Steps 4-5 — aggregate and write
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeResults(result, dryRun) {
  let previousLatest = null;
  if (fs.existsSync(LATEST_PATH)) {
    try {
      previousLatest = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));
    } catch {
      previousLatest = null;
    }
  }
  const changed =
    !previousLatest ||
    JSON.stringify(previousLatest.matches) !== JSON.stringify(result.matches) ||
    previousLatest.status === "no_scan_run_yet";

  if (dryRun) {
    console.log(JSON.stringify(result, null, 2));
    console.log("\n--dry-run: scanResults files were not written.");
    return changed;
  }

  fs.mkdirSync(path.dirname(LATEST_PATH), { recursive: true });
  writeFileAtomic(LATEST_PATH, JSON.stringify(result, null, 2) + "\n");

  // History is a summary per run, not the full matches/queries payload --
  // latest.json already holds the most recent run's full detail, and a
  // growing file of every run's complete match list would balloon quickly.
  const history = loadHistory();
  history.unshift({
    scan_id: result.scan_id,
    ran_at: result.ran_at,
    ruleset_version: result.ruleset_version,
    match_count: result.matches.length,
    query_count: result.query_count !== undefined ? result.query_count : result.queries_executed.length,
    mode: result.mode,
  });
  writeFileAtomic(
    HISTORY_PATH,
    JSON.stringify(history.slice(0, MAX_HISTORY_RUNS), null, 2) + "\n"
  );

  return changed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/run-repo-scan.js [--dry-run] [--token <token> | --gh] [--limit <n>] [--verbose]

Options:
  --dry-run       Build every query but send none -- no token needed.
  --token <t>     GitHub token (also read from GITHUB_TOKEN).
  --gh            Send each search through the gh CLI's own login instead of a token.
  --limit <n>     Only run the first n derived queries (useful for a quick test).
  --verbose       Print each query's result count as it runs.
  --fresh         Start from the first query even if a checkpoint exists.
  --reverify <f>  Apply the exact-dependency check to an existing results file
                  (needs --gh or a token); no searches are run. Resumable.

Without --dry-run and without a token or --gh, this prints the usage and exits --
GitHub's code search API requires authentication even for public repos.`;

function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--dry-run": args.dryRun = true; break;
      case "--token": args.token = argv[++i]; break;
      case "--limit": args.limit = Number(argv[++i]); break;
      case "--verbose": args.verbose = true; break;
      case "--gh": args.gh = true; break;
      case "--fresh": args.fresh = true; break;
      case "--reverify": args.reverify = argv[++i]; break;
      case "--help":
      case "-h": args.help = true; break;
      default: throw new Error(`unknown argument "${flag}"`);
    }
  }
  args.token = args.gh ? GH_CLI : args.token || process.env.GITHUB_TOKEN || null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return false;
  }
  if (!args.dryRun && !args.token) {
    console.error("No token supplied and --dry-run not set.\n");
    console.log(USAGE);
    process.exitCode = 2;
    return false;
  }

  if (args.reverify) {
    if (!args.token) {
      console.error("--reverify needs --gh or a token.");
      process.exitCode = 2;
      return false;
    }
    return reverify(path.resolve(args.reverify), args.token);
  }

  const { entries, version } = loadRuleset();
  let queries = buildQueries(entries);
  if (args.limit) queries = queries.slice(0, args.limit);

  console.log(
    `${args.dryRun ? "Dry run" : "Live run"}: ${queries.length} quer${queries.length === 1 ? "y" : "ies"} from ${entries.length} ruleset entries.`
  );

  // A --limit run is a quick test and keeps no checkpoint.
  const checkpointing = !args.dryRun && !args.limit;
  const fingerprint = queriesFingerprint(queries);
  const resume = checkpointing && !args.fresh ? loadCheckpoint(fingerprint) : null;
  if (resume) console.log(`Resuming at query ${resume.done + 1} from the checkpoint saved ${resume.saved_at}.`);

  const { matches, executed, stoppedEarly, skippedOwn } = await runQueries(queries, args.token, {
    dryRun: args.dryRun,
    verbose: args.verbose,
    resume,
    save: checkpointing ? (state) => saveCheckpoint(fingerprint, state) : null,
  });

  if (checkpointing && stoppedEarly) {
    console.log(
      `Stopped early: ${executed[executed.length - 1]}\nProgress is in ${path.relative(ROOT, CHECKPOINT_PATH)}; ` +
        "run the same command again to continue. latest.json was not changed."
    );
    return false;
  }

  const ranAt = nowIso();
  const mode = args.dryRun ? "dry-run" : "live";
  const result = {
    scan_id: `repo-scan-${ranAt.replace(/:/g, "-")}-${crypto.randomBytes(3).toString("hex")}`,
    ran_at: ranAt,
    ruleset_version: version,
    mode,
    query_count: executed.filter((l) => !isDropNote(l)).length,
    matches,
    queries_executed: executed,
    status_note:
      `Mode: ${mode}. ${queries.length} quer${queries.length === 1 ? "y" : "ies"} derived from ${entries.length} ` +
      `ruleset entries; ${matches.length} match(es)${stoppedEarly ? " -- STOPPED EARLY, see the last queries_executed entry" : ""}` +
      `${skippedOwn ? `, and ${skippedOwn} hit(s) in this site's own repositories suppressed, which are this site's published ruleset and results being matched back` : ""}. ` +
      `A match means the search index found the indicator string in a public repository -- it is not a determination ` +
      `that the repository or its owner is malicious, and every row requires manual review against the cited source.`,
  };

  const changed = writeResults(result, args.dryRun);
  console.log(`${matches.length} match(es) across ${executed.length} executed quer${executed.length === 1 ? "y" : "ies"}.`);
  if (!args.dryRun) console.log(`Wrote ${path.relative(ROOT, LATEST_PATH)} and ${path.relative(ROOT, HISTORY_PATH)}`);
  if (checkpointing) fs.rmSync(CHECKPOINT_PATH, { force: true });
  return changed;
}

if (require.main === module) {
  main()
    .then((changed) => console.log(`CHANGED=${changed}`))
    .catch((err) => {
      console.error(`Scan failed: ${err.message}`);
      console.log("CHANGED=false");
      process.exitCode = 1;
    });
}

module.exports = { derive, buildQueries, isPackageRule, isVerifiableRule };
