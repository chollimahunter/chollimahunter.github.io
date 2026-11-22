# GitHub collaborators

`scripts/gh-collaborators.js` lists the accounts that work inside indexed
personas' own repositories. Operator teams share repositories: on 22 November
2026 one listed account's casino repository carried commits from four indexed
personas and two addresses no list held, interleaved over the same weeks.

```
node scripts/gh-collaborators.js collect [--limit N] [--force] [--repos N] [login ...]
node scripts/gh-collaborators.js rank [--min N]
```

Most of what a persona's repositories carry is copied history: a template's
upstream authors, committed long before the persona's copy existed. The script
separates the two by date. A commit whose committer date falls before the
repository was created in the persona's account came with the copy; one dated
after it is somebody working in the repository. Only the second kind is kept.

`collect` reads, for each live `github_profile` (not removed or recycled, not
PolinRider, no `attribution_doubt`), its most recently pushed non-fork
repositories (default 20) and the latest 100 commits of each, and records every
identity other than the owner's that committed after creation: the account
GitHub attributes the commit to, the author address and name, the account id
inside a noreply address, the date and the commit. It uses the core API only,
so it runs beside the search-based pivots without sharing their limit; a full
pass is about 25,000 requests, roughly five hours at the core limit. Results go
to `_drafts/private/gh-collaborators.json`, rewritten after every account.

`rank` groups identities across owners (by account where GitHub names one,
else by noreply id, else by address) and keeps those working in at least
`--min` (default 2) different indexed accounts' repositories, marking those
the index already holds. Gmail addresses are compared folded, as the index
stores them.

`--hints` also keeps an identity found with only one owner when its login,
address or name shares a word of four or more letters or a run of three or
more digits with the owner's login or the owner's own commit addresses (read
from `gh-identity-pivot.json` and `gh-email-owners.json` when present), with
common words such as dev, super or crypto ignored. It surfaces two things: an
address the persona itself commits from that the index does not hold, and a
second persona built on the same name, such as a "warlord" address in a
repository whose owner commits as another "warlord".

A collaborator of two personas is a lead. One found in fifty is a client, a
freelance platform's bot or a shared template, and the count is printed so a
reader can tell. A collaborator can also be a victim employer whose
repository the persona was given access to; those stay private and are never
filed.
