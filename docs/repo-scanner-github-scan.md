---
name: github-scan
type: on-demand-tool
version: "1.0.0"
description: >
  On-demand tool the Chollima Hunter site owner runs manually (not part of
  automated site-content generation) to search GitHub's public code/repo
  search surface for matches against the repo-scan IOC ruleset -- covering
  BeaverTail, InvisibleFerret, and OtterCookie across both the Contagious
  Interview and PolinRider vectors -- and write a static results JSON that
  the results page renders. See also docs/repo-signature-check.md for the
  local-directory signature scan, a second way to run this tool.
---

# github-scan — on-demand repo scanning tool

## What this is

`github-scan` is implemented as `scripts/run-repo-scan.js`, which the site
owner runs on demand whenever they want to refresh the results page with a
real GitHub search pass. It is deliberately **not** wired into the 11ty
build or any CI job — GitHub search API rate limits and the sensitivity of
publishing "this repo looked suspicious" results mean a human should
trigger and review every run.

```
node scripts/run-repo-scan.js --dry-run              # build every query, send none
GITHUB_TOKEN=ghp_xxx node scripts/run-repo-scan.js    # live run, full ruleset (hours: two queries per package)
node scripts/run-repo-scan.js --token ghp_xxx --limit 20 --verbose   # quick live test
node scripts/run-repo-scan.js --gh                   # live run through the gh CLI's own login
```

`--gh` sends each search through `gh api` instead of `fetch`, so no token is
read into the process at all; it is the simplest option on a machine where
`gh auth login` has been run. The rate-limit budget scales with the number of
queries (one extra wait per 40), so a run over the full ruleset is not cut
short by a limit sized for a small one.

A full run takes about six hours, so it saves its progress to
`_drafts/repo-scan/checkpoint.json` (git-ignored) before every query. If the
process dies, rerunning the same command resumes at the query it stopped on,
provided the ruleset has not changed; `--fresh` starts over. A run stopped by
rate limiting keeps its checkpoint and leaves `latest.json` untouched, rather
than publishing a partial result. `--limit` and `--dry-run` runs keep no
checkpoint.

**Preferred way to supply the token**: copy `.env.example` to `.env`, fill in
`GITHUB_TOKEN=`, and run with Node's built-in env-file loader --
`node --env-file=.env scripts/run-repo-scan.js`. `.env` is gitignored and
never committed; this avoids the token ever appearing in shell history or
a chat transcript, unlike passing it inline via `GITHUB_TOKEN=... node ...`
or `--token`.

The six steps below describe what the script does internally — useful if
you're debugging its output or running the equivalent steps by hand. For a
local checkout rather than a remote GitHub search, see
`docs/repo-signature-check.md` instead — a second, offline way to run this
tool that checks a directory directly for PolinRider's published injection
signatures.

A full run is paced by GitHub's code-search rate limit and scales with the
ruleset: at 117 entries it took about 18 minutes, and the September 2026
addition of some 600 npm package names from Socket's published waves roughly
multiplies that by seven. Use `--limit` for a quick check.

## Step 1 — Load the ruleset

Read `src/_data/iocs/repo-scan-ruleset.json` (see that file for the current
field shape and entry count). Record its effective version —
this repo-scan ruleset file doesn't carry its own version field, so use the
latest `date_added` value across all entries (or the file's last-modified
date) as `ruleset_version` in the output.

## Step 2 — Derive queries from the ruleset

For each IOC entry, derive one or more GitHub search queries:

| `ioc_type`        | Query derivation                                                                                          | Search surface           |
|--------------------|--------------------------------------------------------------------------------------------------------------|---------------------------|
| `github_dork`      | Use `value` verbatim as the query string.                                                                     | code search                |
| `npm_package`      | `filename:package.json "{value}"` (dependency reference) and `filename:package-lock.json "{value}"`.          | code search                |
| `pypi_package`     | `filename:requirements.txt "{value}"` and `filename:pyproject.toml "{value}"`.                                | code search                |
| `filename`         | `filename:{value}` (for literal filenames) — for multi-value entries like "MiroTalk.dmg / MiroTalk.msi", split on `/` and query each value separately. | code search |
| `domain`           | `"{value}"` verbatim, quoted — matches the literal C2/staging hostname appearing in source (e.g. inside a `.vscode/tasks.json` curl target or a hardcoded fetch URL). | code search |
| `wallet_address`   | `"{value}"` verbatim, quoted — matches the literal address string, e.g. a blockchain dead-drop address hardcoded into a loader stub. | code search |
| `ip_address`       | `"{value}"` verbatim, quoted — matches a hardcoded C2 IP:port string. | code search |
| `c2_pattern`       | Not directly searchable as GitHub queries (these are network indicators, not repo content) — skip at query-derivation time; retained in the ruleset for analyst reference during manual review of any match's surrounding code, and machine-testable locally per `docs/repo-signature-check.md` where a `detection` block is present. | n/a |

Build the full `queries[]` array before running any searches — this list
is what gets recorded in the output's `queries_executed[]` for
transparency, so it must be complete even if some queries return nothing.

## Step 3 — Run the searches

Run each query from Step 2 against GitHub's code search API
(`GET /search/code`) — `scripts/run-repo-scan.js` uses this one endpoint for
every derived query, including the `github_dork` ones:

- **Live mode** requires a token: `--token <t>` or a `GITHUB_TOKEN` in the
  environment. `scripts/run-repo-scan.js` reads only those two; it does not
  itself check `gh auth status` or otherwise read the `gh` CLI's own session.
  Either way this is the site owner's own GitHub account/token, never a
  credential this tool provisions itself.
- **Dry-run mode** (no auth available) is the expected state during normal
  site-content generation and CI: validate query syntax only, return an
  empty `matches[]`, and note in `rate_limit_notes` that no live search
  happened. This is exactly the mode used to produce the placeholder
  `src/_data/scanResults/latest.json` shipped with this feature.

### Exact-dependency check (npm and PyPI rules)

Code search matches substrings, so a search for the package `config-log`
also returns projects that depend on `eslint-config-log-level`. For every
`npm_package` and `pypi_package` rule the script therefore downloads each
matched manifest at the commit the search returned (through `gh api` on the
repository contents endpoint, never printing a token) and keeps the match only
when the package is declared there under exactly that name: a key of
`dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies`
in a `package.json`; a `node_modules/<name>` key or a `dependencies` key in a
lockfile; a requirement whose name (before extras and version specifiers, with
case and `-`, `_`, `.` treated as equal) matches in `requirements.txt` or
`pyproject.toml`. A scoped name matches only itself. The parsing lives in
`scripts/lib/dependency-match.js`. Dropped matches are counted per rule in
`queries_executed`, as are matches whose file could no longer be retrieved.
Domain, wallet, IP address, filename and dork rules are not verified this way.

`--reverify <results file>` applies the same check to an existing results file
without searching again, rewriting it and the matching `history.json` entry.
Verdicts are cached in `_drafts/repo-scan/verdicts.json`, so an interrupted run
resumes; a run with fetches still failing after retries writes nothing.

### Rate limits (live mode)

GitHub's search API limits:

- **Unauthenticated**: 10 requests/minute — not a supported mode for a real
  run.
- **Authenticated (personal access token)**: GitHub's docs advertise 30
  requests/minute for code search, but a real run hit a 403 after 11 queries
  at ~2.1s spacing, so the actual limit runs stricter in practice (check
  `gh api rate_limit` before a run rather than trusting the published
  figure). `scripts/run-repo-scan.js` paces requests 6.5 seconds apart and,
  on a 403/429, waits out the `x-ratelimit-reset` header and retries the
  same query rather than aborting.
- The current ruleset (810 entries in `repo-scan-ruleset.json`) derives well
  over a thousand queries — mostly `npm_package` entries, which produce two
  each — so a full pass does not fit inside one rate-limit window even
  paced correctly; expect a live run of the full ruleset to take hours, as
  the usage comment at the top of this document says. `--limit <n>` runs
  only the first *n* queries for a quick check.
- If a query is rate-limited too many times to keep waiting it out
  (`MAX_RATE_LIMIT_WAITS_TOTAL` / `MAX_RATE_LIMIT_RETRIES_PER_QUERY` in the
  script), the run stops, records how many queries completed in
  `queries_executed`, and reports the limit rather than failing silently —
  resume by re-running only the remaining queries.

## Step 4 — Aggregate into the `scan_result` shape

Combine the search output into this shape:

```json
{
  "scan_id": "<uuid or ISO-timestamp-based id>",
  "ran_at": "<ISO 8601 timestamp of this run>",
  "ruleset_version": "<from Step 1>",
  "mode": "<'dry-run' or 'live'>",
  "matches": [
    {
      "ioc_id": "<matched IOC's id from the ruleset>",
      "matched_value": "<the literal value that matched>",
      "location": "<repo or file URL>",
      "matched_at": "<ISO 8601 timestamp>",
      "context": "<short snippet — never a full file/repo clone>",
      "kind": "<'research' or null, see 'Match kind' below>"
    }
  ],
  "queries_executed": ["<query string 1>", "..."],
  "status_note": "<prose summary — mode, query and ruleset-entry counts, match count, and the standing caveat that a match is a lead for manual review, not a finding>"
}
```

### Match kind: the "detection or research repository" tag

Some matches sit inside a repository that quotes the indicator on purpose: a
detection-rule repository (a YARA or Snort ruleset), an indicator collection
(a CSV or text file of published IOCs), or a scanner or cleanup tool built to
find PolinRider's own injection pattern. A repository like that renders
identically to a possibly compromised project in the scan-match table unless
it is flagged, since both cases are simply a string match against a known
indicator. `scripts/run-repo-scan.js` sets `matches[].kind` to `"research"`
for exactly this case, `null` otherwise, using the heuristic implemented once
in `scripts/lib/scan-match-kind.js` (shared with the template, so the two can
never disagree). The heuristic looks at the matched file's path and the
repository's name for tokens associated with detection tooling or indicator
collections (`ioc`, `indicator`, `signature`, `threat-intel`, `detection`,
`rules`, `scanner`, `cleanup`, `cleaner`, `sample`, `poc`, `fixture`, `yara`,
`workshop`, and a YARA/YAML rule file under a `rules/` or `detections/`
directory) and is documented in full, including why a bare "test" token was
tried and dropped for matching unrelated application code, in the comments at
the top of that file.

The results page renders this as a `.tag-chip` reading "detection or research
repository" in the Context cell of any tagged row. It is a heuristic on the
matched path and repository name only, not a verified classification, and
carries no weight beyond that: a tagged repository is not established as
legitimate any more than an untagged one is established as compromised. A
run's `matches[]` predates the `kind` field for any scan recorded before this
was added, so the page falls back to running the same heuristic at build time
for a match with no `kind` set, through the `scanMatchKind` Nunjucks filter in
`.eleventy.js`.

## Step 5 — Write the results file

Overwrite `src/_data/scanResults/latest.json` with the aggregated
`scan_result` object from Step 4, and prepend a summary (`scan_id`,
`ran_at`, `ruleset_version`, `match_count`, `query_count`, `mode`) to
`src/_data/scanResults/history.json`, capped at the most recent 20 runs.
`latest.json` carries the most recent run's full detail; `history.json`
is what the results page's "Scan history" table renders.

## Step 6 — Human review before any public claim

This is the non-negotiable step. Per the site's sourcing methodology (see
`/sources/#sourcing-methodology`):

- Every match in `latest.json` is a **lead for manual review**, not a
  finding. A string match against a filename or dork does not by itself
  establish that a given repository or its author is malicious, compromised,
  or affiliated with DPRK operators — it establishes that the repository's
  content or metadata matched a search pattern associated with previously
  reported Contagious Interview activity.
- Before citing any specific match publicly (e.g. writing it into a profile
  or hunt page), an analyst must independently examine the matched
  repository/file and, where the claim concerns a named individual, meet
  this site's existing citation bar (a public record — not the scan match
  itself) before publishing that claim.
- The results page carries a `.disclaimer-banner` stating this explicitly
  (see `src/repo-scanner/index.njk`) so this constraint is visible to
  every site visitor, not just the operator running the tool.

## Re-running

There's no schedule — this is deliberately manual. Re-run Steps 1-6
whenever the site owner wants a refreshed pass, e.g. after new IOC entries
are added to the ruleset following new public threat-intel reporting.
