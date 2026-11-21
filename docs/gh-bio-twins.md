# GitHub bio twins

`scripts/gh-bio-twins.js` looks for GitHub accounts outside the index that
carry the same profile bio as an indexed account. A persona's bio is often a
sentence nobody else on GitHub wrote, so a second account with it is a lead.
The method came from one search on 21 November 2026: exactly two accounts on
GitHub carried one short motto as their bio, both with the same numeric
suffix, and each held commits from the own address of a different indexed
persona.

```
node scripts/gh-bio-twins.js [--limit N] [--force] [--max-hits N]
```

For each live `github_profile` (the same seeds as `docs/gh-follow-graph.md`:
not removed, not PolinRider, no `attribution_doubt`) it reads the profile and
searches users whose bio contains the first eight words of it as a phrase,
with punctuation removed. Both limits come from testing: a `|` in the phrase,
or a phrase much longer than eight words, returned nothing, not even the
account itself. Each entry records `self_found`, whether the account's own
search found it; when it did not, an empty result means nothing.

A bio under four words, or one more than `--max-hits` accounts share (default
5), is common text and is recorded without its matches. Results go to
`_drafts/private/gh-bio-twins.json`, rewritten after every account so a
stopped run resumes, with `leads` listing each outside account and the
indexed accounts that share its bio.

A shared bio is a resemblance, not a shared value. Generic phrasing ("I'm a
senior full stack blockchain developer") turns up strangers; a match is worth
a reviewer's time when the sentence is unusual and something else agrees, such
as a commit address, a numeric suffix or a creation date. Leads stay in the
private repository and are filed only on their own evidence.
