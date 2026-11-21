# GitHub follow-graph pivot

`scripts/gh-follow-graph.js` looks for GitHub accounts this index does not
hold inside the follow network of the accounts it does. DPRK IT-worker
personas follow one another in tight clusters: Nisos and NK Internet both name
mutually connected followers as a signal of a persona network. An account that
several known operator accounts follow, or that follows several of them back,
is worth a person's time.

## Running it

```
node scripts/gh-follow-graph.js collect [--limit N] [--force]
node scripts/gh-follow-graph.js rank [--min N] [--top N]
```

`collect` reads the followers and following lists of every seed account, up
to ten pages of 100 each, through `gh api`. It writes the lists to
`_drafts/private/gh-follow-graph.json` after every account, so a run that is
stopped resumes where it left off; `--force` reads every seed again. A full
pass is two to four calls per seed, within the authenticated rate limit in
about an hour.

`rank` counts, for every account outside the index, how many distinct seeds it
is connected to and how many of those links run both ways. It keeps accounts
connected to at least `--min` seeds (default 2), scores each as distinct seeds
plus mutual links, reads the profile of the top `--top` (default 600) and
writes `_drafts/private/gh-follow-graph-leads.json`. Profiles already read are
kept from the previous ranking.

Raw counts reward the wrong accounts: follow-for-follow hubs with tens of
thousands of followers touch dozens of seeds by sheer size. The profiled
leads are therefore ordered by concentration, the seed links (distinct seeds
plus mutual links) as a share of the account's whole follow network, weighted
by the square root of the seeds it touches. An account with 1,000 or more
followers, or following 1,000 or more, is flagged `popular` and sorted last.
For scale: `docs/github-account-similarity.md` measured that seven per cent of
ordinary accounts already have one follow edge to a held account, which is why
a single edge never makes a lead.

## Seeds

Seeds are the index's `github_profile` accounts except:

- accounts recorded as removed in `scripts/data/github-account-status.json`;
- accounts tagged PolinRider, which are the owners of affected repositories,
  not operators;
- accounts carrying `attribution_doubt`.

A victim seed would bring in its ordinary contacts, which is why these are
left out.

## Reading the leads

Every lead is a signal, never a finding. Developers follow each other,
follow-for-follow rings connect strangers, and a popular account (flagged
`popular` at 1,000 followers) is followed by everyone. What makes a lead
stronger is what the follow graph cannot show on its own: a young account
with backdated repositories, a word-and-four-digits login (flagged
`dprk_naming`), a commit address or portfolio site shared with an indexed
persona, or a profile photo that matches one. Run gh-fake-analyzer and
`scripts/gh-identity-pivot.js` on a promising lead before filing it, and file
it only on that evidence, attributed as Chollima Hunter research.

The leads name accounts that may belong to uninvolved people, so they stay in
the private repository and reach no published page.
