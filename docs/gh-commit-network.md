# GitHub commit network

`scripts/gh-commit-network.js` reads every commit GitHub attributes to each
indexed account, in anyone's repository, and lists the accounts and
identities around it.

```
node scripts/gh-commit-network.js collect [--limit N] [--pages N] [--force] [login ...]
node scripts/gh-commit-network.js rank [--min N] [--all]
```

The other GitHub pivots read an account's own profile and repositories.
This one reads the account's commits everywhere, which is where teams show:
on 23 November 2026 one indexed account's commits, read by hand, sat in the
repository of another indexed persona, carried a third account's former
handle as author name, and used the operator's GitLab login as another. The
pivot repeats that reading for every account.

`collect` costs one commit search per account (more with `--pages`, at 100
commits a page, up to 10). A live account is searched as `author:<login>`. A
removed account cannot be searched by name, but its commits keep its noreply
address, so it is searched as `<id>+<login>@users.noreply.github.com` when
its numeric id is known from the account-status file or the email-owner and
rename pivots; a removed account with no known id is skipped. Accounts with
`attribution_doubt` and those filed only under PolinRider (whose list mixes
affected owners with operators) are left out. Results go to
`_drafts/private/gh-commit-network.json` after every account, so a stopped
run resumes. Spacing follows `GH_SEARCH_GAP_MS` (default 2100 ms); set it to
4000 when another search pivot is running.

`rank` prints three tables:

- **Repository owners** that `--min` (default 2) or more indexed accounts
  commit to. A repository two personas both work in is a team repository;
  one that many commit to may be a client, a template or a victim employer.
- **Author names** shared by two or more indexed accounts, or used by one
  account and shaped like another login (letters with digits). A second
  account's handle usually shows up this way.
- **Commit addresses** the index lacks, the account's own.

A row is a lead, not a finding. A persona commits to the employer it
defrauds, the client that hired it and the open-source projects it pads a
profile with, and the owners of those repositories are victims or bystanders.
An author name can be typed by anyone. Read the commits before filing
anything, file only on the account's own evidence, and keep the results in
the private repository. Own commit addresses are filed by the test used in
PR #95 (own repository, after creation, author name exactly the handle,
two or more commits, free-mail, not name-like); anything else is held.
