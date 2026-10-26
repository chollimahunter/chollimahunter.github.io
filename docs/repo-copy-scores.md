# Copied-repository scores

## What this is

`scripts/score-copied-repos.js` takes each non-fork public repository of the indexed GitHub accounts, looks for the repository it was probably copied from, and scores how close the two are. It was inspired by shortdoom/audit-compare, which clones two repositories and diffs them. The output is `scripts/data/repo-copy-scores.json`. Nothing on the site reads that file, and a flag in it is a similarity measurement, not attribution: copying a tutorial, a template or a package is ordinary, and a repository that mirrors a collection of malware samples may be a mirror rather than an author.

## Enumeration

The accounts are every `github_profile` in the index except one recorded as removed in `scripts/data/github-account-status.json`, the same enumeration `scripts/gh-analyzer-targets.js` uses. For each account the script reads up to 25 non-fork, non-empty repositories (under 50 MB), most recently pushed first. Authentication goes through `gh api`, so no token is read or stored. The run is resumable: an account already present in the output is skipped unless `--refresh` is given. `--limit N` caps the accounts processed in each of the two groups (personas, control), `--repos N` caps repositories per account, and `--account LOGIN` runs one account without the control.

## Origin heuristic

GitHub reports no parent for a repository that was copied rather than forked, so the origin is inferred. Candidates come from three signals, and at most the three best-supported candidates per repository are cloned:

1. GitHub URLs in the repository's own README, other than the owner's own.
2. Repository code search for the longest distinctive line (40 to 120 characters, not an import, comment or quoted string) among the three largest source files.
3. Repository code search for the `name` field of `package.json`.

Searches exclude the owner's own repositories. Both sides are fetched with `git fetch --depth 1` into a temporary directory without a checkout, and the directory is deleted afterwards. The file list and each file's blob hash come from `git ls-tree`, which is the same hash `git hash-object` would produce, so no file is hashed twice and line endings do not matter.

## Score and threshold

For the repository under test, with empty files, licences, lock files and `.gitignore` excluded:

- `hash_share` is the share of its files whose blob hash appears anywhere in the candidate origin.
- `line_share` is, for the five largest source files, the share of non-blank lines found in the origin's file at the same path (or the same file name elsewhere), averaged over the five.

A repository is flagged as a copy when `hash_share` is at least 0.5 with at least 3 identical files, or `line_share` is at least 0.8. The best-scoring candidate is kept. The five highest scores per account are retained even when below the threshold, so the output shows how near a non-flagged repository came.

## Control

A feature common among ordinary developers describes GitHub rather than a finding, so every run includes five ordinary accounts through identical code. They are the first five results, in GitHub's default order, of the user search `created:2023-03-01..2023-09-30 repos:5..25 followers:0..3 type:user`, run on 2 October 2026: `trwng`, `cssupport23`, `GooseBooze`, `cobra225` and `RajaSoundari`. The window sits in the middle of the creation years of the indexed accounts (mostly 2021 to 2025), and the repository and follower bounds keep the accounts small and active. None is in the index. The set is fixed in the script and is small; it gives an order of magnitude for the base rate, not a tight estimate, and it is not known to be free of copiers. Compare the personas' flagged share of repositories checked against the control's, and read the flagged repositories before drawing anything from the ratio.

## First measurement

A run with `--limit 2` on 2 October 2026 covered two persona accounts and two control accounts. The personas had 2 readable repositories, of which 1 was flagged: `0glabs-solid/0g-play`, 305 of 309 files identical to `xndbogdan/malicious-repositories` (`hash_share` 0.987, `line_share` 0.814), an archive of malicious repositories, so the account's repository is a copy or a mirror of that archive. The control accounts had 14 repositories and none was flagged; the highest control `hash_share` was 0.333. Two accounts are far too few to state a rate; the full run is needed.

## Running it

The workflow `.github/workflows/repo-copy-scores.yml` runs it by dispatch only, with no schedule, on the job's own `GITHUB_TOKEN`, and opens a pull request on the branch `repo-copy-scores/results`. Code search is limited to about nine requests a minute, so the script pauses seven seconds before each search and a full run takes many hours. Locally, `node scripts/score-copied-repos.js --limit 20` does a batch.
