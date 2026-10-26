# GitHub account analysis with gh-fake-analyzer

[gh-fake-analyzer](https://github.com/shortdoom/gh-fake-analyzer) is the Ketman
Project's command-line tool for spotting fake developer accounts on GitHub. It
downloads an account's profile, repositories, followers and commit history and
reports patterns that fake accounts tend to show. This site runs it over the
GitHub accounts the index already holds and shows what it finds on each
account's indicator page, under "Account analysis".

## How it runs

`.github/workflows/gh-analyzer.yml` runs daily, and can be dispatched by hand
with a batch size. Each run:

1. `node scripts/gh-analyzer-targets.js 20` picks the next accounts: every
   `github_profile` in the index except one recorded as removed in
   `scripts/data/github-account-status.json`, never-analyzed accounts first,
   then the one analyzed longest ago, persona-anchored before unattributed.
2. `gh-analyze --targets targets.txt --out_path gh-out` runs the tool, pinned
   to the version in the workflow's `GH_FAKE_ANALYZER_VERSION`, with the job's
   own `GITHUB_TOKEN`. Every call reads public data, so no personal token is
   involved.
3. `node scripts/gh-analyzer-summarize.js gh-out targets.txt <version>` merges a
   compact summary of each `report.json` into `scripts/data/gh-analyzer.json`.
   A login with no report is recorded as `status: "no report"` so the next run
   moves on. The full reports are kept as a workflow artifact for 30 days.
4. The result goes to one standing pull request on the branch
   `gh-analyzer/results`, which each run updates. Nothing reaches the site
   until that pull request is merged.

## What is shown

`src/_data/iocIndex.js` attaches `gh_analysis` to each GitHub record it has a
summary for, resolving addresses and accounts to their indicator pages:

- when the account was created, and its original and forked repository counts;
- repositories whose first commit is older than the account, the tool's
  `potential_copy` check: history written elsewhere and pushed here;
- repositories of other owners whose commits all also sit in one of this
  account's own repositories (`duplicate_hashes_found`);
- how many commit addresses and names the account's own commits carry, and
  the most names seen on one address or addresses under one name (the tool's
  identity-rotation check);
- logins or address names shaped like a word followed by four digits, the
  tool's `dprk_naming` check;
- the commit addresses this index already holds, and the indexed GitHub
  accounts the account follows or is followed by.

Commit addresses the index does not hold are counted on the page but not
listed. They stay in `scripts/data/gh-analyzer.json` as leads; filing one
follows the same own-address rule as the commit-address sweep, by hand.

## Reading it

Every one of these is a signal rather than a finding. Ordinary developers
import old repositories, commit from several machines and follow each other;
an operator who is careful shows none of the patterns. The block never
changes an account's attribution, which still rests on the sources it cites.

## Upgrading the tool

Change `GH_FAKE_ANALYZER_VERSION` in the workflow. The summarizer reads only
`profile_info`, `original_repos_count`, `forked_repos_count`, `unique_emails`,
`identity_rotation`, `dprk_naming`, `potential_copy`, `duplicate_hashes_found`,
`following`, `followers`, `mutual_followers` and `organizations_member`; check
those keys still exist in the new version's `report.json` before merging its
first run.
