# Tool: pivoting on handles

## Why the handle and not the address

Searching an operator's email address or telephone number finds nothing. These
identities do not reuse an address across platforms — they reuse a **login**.
`leech_dev`, `climaxstar`, `0xnevo`: one string, registered on site after site,
each registration stating a display name and a date the last one did not.

So the pivot is: take every handle the index already holds for a persona, and
ask each platform whether an account exists under it. A hit on a common handle
is a hit on the handle, not on the operator, so nothing a pass finds is filed
automatically, and most of what it finds belongs to someone else. That is why
the passes' working state and their logs are kept in the maintainer's private
checkout rather than in this repository.

## What gets filed, and what is held

An account is filed in `direct-observations.json` by hand, on the day it was
read, with the note every pivot entry carries: the handle is what links the
account, and nothing establishes that one person holds both. Three kinds of
hit are held back every time:

- **The persona is heading-derived.** A persona recovered from a report
  heading is not a dossier, so an entry naming it opens a second persona page
  instead of joining the first — the grouping joins on a shared value and never
  on a shared handle. These wait for a shared value.
- **The handle belongs to two personas.** Which persona the account belongs to
  is precisely what a shared handle cannot settle, and guessing would assert a
  link no evidence supports.
- **The account is plainly somebody else's**: a company, a shop, a channel on
  an unrelated subject, or a page stating a real-looking full name that
  expands the handle, which is as consistent with a real person owning both
  accounts as with the persona.

Display names that are personal names are carried as aliases; display names
that are slogans, job descriptions or the handle typed again stay in the note,
per the rule that `aliases[]` holds names.

## Probing platforms directly

The probes use each platform's own public API rather than scraping:

    https://gitlab.com/api/v4/users?username=HANDLE
    https://dev.to/api/users/by_username?url=HANDLE

**dev.to rate-limits hard** and returns 429 with no warning; a two-second pause
between requests carries a full run. GitLab's public user record does **not**
include a registration date — that is read from `Member since` in the static
HTML of the profile page, following the redirect to the canonical
capitalisation. The GitHub API allows 60 requests an hour unauthenticated,
which is not enough for a pass of any size without a token.

## Running it with Maigret

The broad pass runs through [Maigret](https://github.com/soxoj/maigret), which
asks a few hundred sites at once. `scripts/pivot-handles-maigret.js` wraps it:

    python -m pip install --user maigret        # once
    npm run pivot:handles                        # every handle not checked in 90 days
    node scripts/pivot-handles-maigret.js --limit 100
    node scripts/pivot-handles-maigret.js --handle kanbei0605

It takes every handle from the account-shaped indicators in the index, with
the handles a persona actually holds first, and runs Maigret against its top
500 sites for each (about twenty seconds a handle; `--top-sites 200` is faster
and `--include-email-locals` adds the consumer-mail local parts).

**It writes a review page, never a record.** The page sorts each handle's hits
into platforms the index models, which can become an indicator, and everything
else, which can at most be noted in an entry's `unextracted[]`. A hit that
rests on a status code alone is marked weak, because several sites answer 200
to any path. Its state, which remembers what was asked so a pass does not
repeat itself for ninety days (`--force` overrides that), lives in the private
checkout. It is not a scheduled workflow.

## GitHub code search

The Maigret pass asks platforms whether an account exists under a handle. This
one asks GitHub's code where the handle is written down, and reads what sits
beside it. `scripts/pivot-handles-github.js` takes every handle the index holds
for a named persona (GitHub, X, Telegram and LinkedIn), searches the next batch
in GitHub's code, skips research, tracker and bulk-dataset repositories, and
reads each remaining file for emails, EVM wallets and Telegram, X, LinkedIn and
Discord values within 400 characters of the handle.

About one lead in six is the persona's own: contact blocks and profile READMEs
in the persona's own repositories, and alternate accounts whose README or
portfolio gives the persona's address or accounts. The rest are forks carrying
an operator's address in package metadata, copied portfolio templates still
holding the template author's links, client team pages, seed and test data, and
project contract addresses. File a lead in `direct-observations.json` only when
the file is the persona's own or credits its accounts, citing the file, and
move its key to `reviewed` whether it is filed or not, so it never returns.
`scripts/data/handle-pivot-github.json` records when each handle was searched
and the reviewed keys, sealed; the unreviewed leads are written to the private
checkout. `.github/workflows/handle-pivot.yml` is dispatch-only, because a
pull request here would publish the unreviewed leads.
