# Workflows

Every workflow lives in `.github/workflows/`. Each action is pinned to a full
commit SHA, and Dependabot (`.github/dependabot.yml`) proposes updates to
those pins and to the npm dependencies weekly, one grouped pull request per
ecosystem.

| File | Trigger | What it does | Opens or deploys | Secret | Doc |
| --- | --- | --- | --- | --- | --- |
| `deploy.yml` | push to `main`, manual | `npm ci`, validate, build, check, CSS check, unit tests; plans an IndexNow submission | deploys `_site` to GitHub Pages, then submits changed URLs to IndexNow | none | `docs/search-indexing.md` |
| `ci.yml` | pull request to `main`, manual (dispatched by the data workflows) | the same validate, build, check, CSS-check and unit-test sequence as `deploy.yml`, as the check `ci` | nothing | none | this file |
| `sync-itworker-datasets.yml` | Mondays 06:00 UTC, manual | syncs DTEX's email appendix, Spur's Astrill exit list and IPRoyal's free proxy list | pull request `sync/itworker-datasets` | none | `docs/sync-dtex-itworker-emails.md`, `docs/sync-spur-astrill-ips.md`, `docs/sync-iproyal-free-proxies.md` |
| `scrape-dprk-iocs.yml` | Mondays 07:00 UTC (changed-only), the 1st of each month 09:00 UTC (full), manual | discovers new articles, scrapes sources, ingests the runs | pull request `sync/scraped-iocs` | none | `docs/scrape-dprk-iocs.md`, `docs/discover-sources.md` |
| `gh-analyzer.yml` | daily 07:40 UTC, manual | runs gh-fake-analyzer over the next batch of GitHub accounts | pull request `gh-analyzer/results` | none | `docs/gh-fake-analyzer.md` |
| `handle-pivot.yml` | manual only (its leads would be public in a pull request; usually run locally) | searches GitHub code for persona handles and records leads | pull request `handle-pivot/leads` | none | `docs/handle-pivot.md` |
| `etherhiding-refresh.yml` | every other day 06:15 UTC, manual | re-reads the EtherHiding watchlist from public RPC endpoints, and the XCTDH TRON and Aptos pointers from TronGrid and the Aptos REST API | pull request `etherhiding/refresh`, only when an observation moved | none | `docs/etherhiding-contract-check.md` |
| `etherhiding-hunt.yml` | the 1st of each month 07:40 UTC, manual (optionally seeded) | rebuilds each watchlisted contract's write history from its transactions and rotation events, follows the writing wallets, and sweeps a week of blocks for new EtherHiding contracts | pull request `etherhiding/writes` (write histories, merges itself when green); candidates in the job summary | `ETHERSCAN_API_KEY` (Polygon), `NODEREAL_API_KEY` (BSC) | `docs/etherhiding-hunt.md` |
| `enrich-refresh.yml` | Sundays 05:20 UTC, manual | re-runs the platform-account, GitHub-account, malware-status and OSV enrichers | pull request `enrich/refresh` | none | `docs/enrich-refresh.md` |
| `repo-copy-scores.yml` | manual only | scores the next batch of GitHub accounts for copied repositories | pull request `repo-copy-scores/results` | none | `docs/repo-copy-scores.md` |
| `x-sweep-reminder.yml` | the 1st of each month 14:23 UTC, manual | opens an issue reminding a person to sweep X by hand; reads and changes nothing in the repository | an issue | none | `_drafts/private/docs/x-source-backlog.md` |
| `check-indexing.yml` | daily 13:17 UTC, manual | asks the Search Console URL Inspection API about hub pages and a sample of indicator pages | nothing; writes the run summary | `GSC_SERVICE_ACCOUNT` | `docs/search-indexing.md` |

"none" means the workflow uses only the token GitHub issues to each run.

## Changing `main`

The "Protect main" ruleset requires every change to arrive through a pull
request with a passing `ci` check; nothing is pushed to `main` directly, by a
person or a workflow. Work on a branch, run the same sequence locally
(`npm test` runs validate, build, check, check:css, test:unit and
audit:integrity), open the pull request, wait for `ci`, squash-merge, and let
GitHub delete the branch (`delete_branch_on_merge` is on). A pull request
opened by a workflow on this public repository gets a `pull_request` run that
waits at "action_required" until it is approved
(`gh api -X POST repos/<owner>/<repo>/actions/runs/<id>/approve`).

## Validating pull requests opened by a workflow

A pull request opened with a workflow's own `GITHUB_TOKEN` triggers no
`pull_request` run; GitHub does this so that one workflow cannot set off
another by accident. `ci.yml` therefore does not run on its own for the pull
requests the seven data workflows open (every one above that opens a pull
request). Instead, each of them, straight after
it creates or updates its pull request, dispatches `ci.yml` on the pull
request's branch (`gh workflow run ci.yml --ref <branch>`), which GitHub does
allow. The run reports its `ci` check on the branch's head commit, so it shows
on the pull request. The dispatch step is `continue-on-error`: if it fails,
the data job still passes and the pull request stays open with no check,
and `ci.yml` can be run on its branch by hand from the Actions tab.

The dataset sync also runs `scripts/sync-iproyal-free-proxies.js`, which keeps
IPRoyal's free proxy list as a labelled IP dataset; see
`docs/sync-iproyal-free-proxies.md`.

## Auto-merge for trusted data runs

`etherhiding-refresh.yml`, `gh-analyzer.yml` and `enrich-refresh.yml` merge
their own pull request once the dispatched `ci` run on its branch succeeds.
The one-line toggle is `AUTO_MERGE` in each workflow's top-level `env`; the
other four data workflows carry it set to `"false"` and stay on manual review.
The composite action `.github/actions/merge-when-green` squash-merges only the
workflow's own branch and only when the `ci` run tested the pull request's
current head. A merge made with `GITHUB_TOKEN` triggers no push run, so the
action then dispatches `deploy.yml` on `main`. If branch protection, a
conflict, a stale run or a timeout stops the merge, the pull request stays
open with a warning and the job passes. A failed `ci` run or a refused merge
is recorded in the shared "Scheduled workflows need attention" issue, so a
blocked merge is never silent.

**Two things on GitHub's side let the workflow merge.** The "Protect main"
ruleset requires `ci` and no approvals; its option requiring an approval for
changes not made by a person must stay off, since `GITHUB_TOKEN` cannot give
one (turned off 2026-10-11). And GitHub holds the pull request's own
`pull_request` run of `ci` at "action_required", and the required check is not
met until that run passes, so the action approves that run through the API
and waits for it before merging.

The EtherHiding refresh adds a gate, `scripts/etherhiding-review-gate.js`,
which compares the whole findings file with the previous run's. Everything a
refresh adds merges: a new C2 value, rotation, payload or bytecode is an
on-chain observation, and the tracker marks a host nobody has reviewed as
unreviewed; nothing becomes an indicator until a person files it, and parked
values go in `scripts/data/etherhiding-c2-review.json`. What it holds for a person is
data loss (an observation, rotation run, write, payload or code that was
recorded before and is missing now), rewritten history, a degraded run (more
than 5% of chain queries failed), and anything it does not recognise. Each run
adds an entry to one standing issue, "EtherHiding: on-chain values to review":
the values a merged run added, or why a run was held. Entries after the first
are written into the issue's body, newest first, rather than posted as
comments, because GitHub emails on a comment but not on an edit.

## When a data job fails

The data steps run under `shell: bash`, which GitHub starts with
`-eo pipefail`, so a script that crashes while its output is piped through
`tee` fails its step instead of passing silently.

- `handle-pivot.yml` and `gh-analyzer.yml` stop at the failed step and open
  no pull request. `gh-analyze` itself may fail per account, but the
  summarizer exits 1 when no account produced a report, so a dead batch fails
  the job instead of leaving the accounts out of rotation.
- `scrape-dprk-iocs.yml` lets discovery and scraping fail independently
  (`continue-on-error`), so the pull request for whatever did succeed is still
  opened. A final step then fails the run, with a line in the job summary,
  whenever either of them failed, so the outage is reported by GitHub's usual
  failed-run notification rather than hidden behind a green run. Both scripts
  exit 1 when more than half the sources, or more than half the feeds, could
  not be read. The enrichers it runs afterwards are `continue-on-error` and
  fail nothing. An unmerged `sync/scraped-iocs` branch is carried over before
  the run, so its work is not lost.
- `sync-itworker-datasets.yml` works the same way: each sync is
  `continue-on-error`, and a final step fails the run only when both failed.

`gh-analyzer.yml` runs in two jobs. `analyze` installs and runs the
third-party tool with a read-only token and no stored git credentials, from a
requirements file that pins every package in its dependency tree to a version
and to its published sha256 digests
(`.github/requirements/gh-fake-analyzer.txt`). `propose` holds the write
permissions and opens the pull request from the results `analyze` hands on
as an artifact. Changing the tool's version means regenerating that file and
the `GH_FAKE_ANALYZER_VERSION` value together; the install step fails if they
disagree.

## When a daily workflow fails

`gh-analyzer.yml`, `etherhiding-refresh.yml`, `enrich-refresh.yml` and
`check-indexing.yml` each end with a `notify-failure` job that runs only when
an earlier job failed or a merge was blocked. It uses the composite action
`.github/actions/notify-failure`, which keeps one issue for all of them,
"Scheduled workflows need attention", with one line per workflow giving the
latest message, run link and how many runs have failed since the first. A
repeat failure edits that line in the issue's body instead of commenting, so
the maintainer gets one email when the issue opens and none for later runs;
close the issue once every line is dealt with. That job alone holds
`issues: write`.

## Dependency installation in `deploy.yml`

`deploy.yml` runs `npm ci` when `package-lock.json` exists and falls back to
`npm install` when it does not. `ci.yml` always runs `npm ci`, so a missing
lockfile fails a pull request instead of reaching the deploy.

## Scheduled workflows and inactivity

GitHub disables every scheduled workflow in a repository after 60 days
without repository activity. A disabled workflow shows a banner in the
Actions tab and runs again once re-enabled there. Commits to `main` count as
activity, so this matters only if the repository goes quiet.

## Data audits

`ci.yml` and `deploy.yml` also run `npm run audit:integrity` after the unit tests;
it fails on any structural inconsistency in the indicator data or the built
payload. The weekly scrape appends `scripts/audit-indicators.js` output for the
run's new records to its pull request, as values to check before merging.
