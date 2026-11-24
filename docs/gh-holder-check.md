# GitHub holder check

`scripts/gh-holder-check.js` lists indexed email addresses whose GitHub
holder looks like an established real developer: the index's likeliest false
positives.

```
node scripts/gh-holder-check.js [--min N] [--refresh]
```

It reads the email-owner pivot's results (`docs/gh-email-owners.md`) without
writing to them, so it can run while that sweep is still collecting. Each
holder's profile is fetched once through the core API and cached in
`_drafts/private/gh-holder-profiles.json`; `--refresh` fetches every profile
again. Addresses already withdrawn as false positives are skipped.

Each holder is scored on the signals the withdrawals of 22 and 23 November
2026 rested on, all read by hand at the time: an account five or more years
old (counted twice past eight), 25 or more followers, 30 or more
repositories, an employer, a personal site, a display name shaped like a
person's name, and commits with the address spanning three years or more.
Holders scoring `--min` (default 3) or more are printed highest first, with
the sources behind the address. A value only a bulk list carries (shown as
`bulk:<dataset>`) is the likeliest to be wrong.

A high score is a reason to read the account, not a ruling. Operators buy
aged accounts, inflate followers and fill profiles, so many real personas
score high too. A false positive is withdrawn through
`_drafts/private/false-positives.json` and `npm run seal`, with the reason
recorded there.
