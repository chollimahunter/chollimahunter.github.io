# GitHub identity pivot

`scripts/gh-identity-pivot.js` reimplements the part of
[GitFive](https://github.com/mxrch/GitFive)'s method that needs only the public
GitHub API. For each `github_profile` the index holds, it records the author
names and email addresses the account committed with, then looks for other
GitHub logins that committed with the same address. Its output is
`_drafts/private/gh-identity-pivot.json`, a set of leads for a human reviewer.

## What it does

For each account the script reads, through `gh api`, the commits of up to
fifteen of the account's own non-fork repositories, keeping only commits
GitHub attributes to that login, and the account's public events feed
(`/users/{login}/events/public`), whose push events carry commit author names
and addresses. Addresses issued by GitHub (`users.noreply.github.com`) are not
listed as addresses; one of the form `<id>+<login>@users.noreply.github.com` is
kept separately under `noreply_ids`, because it reveals the account's numeric
id and the login it was created under.

For each real address it then searches commits by author address
(`/search/commits?q=author-email:...`). A login other than the account itself
that appears in the results is recorded under `other_logins`, with the address
that links them and the repository and commit that show it. Each name and
address also carries up to three repository and commit pairs where it was seen,
so a reviewer can open the evidence directly.

Run it as `node scripts/gh-identity-pivot.js --limit 20`, or name logins on the
command line. Accounts with an entry are skipped unless `--force` is given, and
the file is rewritten after every account, so an interrupted run resumes where
it stopped. Searches are spaced to stay under the search API's thirty requests a
minute, and a 403 or 429 response waits for the server's `Retry-After` or
rate-limit reset time before retrying.

## What it deliberately does not do

GitFive needs a logged-in GitHub session. This script does not use one and will
not be extended to: it authenticates only through `gh api`, never reads or
prints a token, and sees only what an anonymous visitor could. Its coverage is
therefore narrower. It cannot see an account's name history, and it reads the
commits of at most fifteen repositories and the most recent events GitHub keeps.
An address that was never committed in a public repository is invisible to it.
It does not run on a schedule, and nothing in `src/` reads its output.

## Reviewing a lead

A shared address is a hint, not a finding. People share addresses legitimately
(an employer, a mailing alias, a collaborator committing on a machine they
share), and a public address can belong to someone whose name an operator
borrowed. A lead is therefore never filed automatically. A reviewer opens the
cited commit, checks whether the address is the account's own (the same
own-address rule as the commit-address sweep), looks for corroboration in a
published source, and only then files the second account or address by hand
with that source in its `sources[]`. A lead that cannot be corroborated stays in
the file and is not published.
