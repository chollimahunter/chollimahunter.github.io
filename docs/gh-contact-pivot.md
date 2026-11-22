# GitHub contact pivot

`scripts/gh-contact-pivot.js` reads the contact details every indexed GitHub
account publishes about itself and lists the ones the index does not hold yet.
A persona's account often names its other channels: an X username in the
profile's own field, Telegram, YouTube, WhatsApp or Discord links among its
social accounts, a mailbox in the bio or email field, a contact block in its
profile README. These sit in the profile sidebar as often as in a file, so a
code search does not find them.

```
node scripts/gh-contact-pivot.js collect [--limit N] [--force]
node scripts/gh-contact-pivot.js rank [--all]
```

`collect` reads every live `github_profile` in the index through GraphQL, 25
accounts a request (about 50 requests for the whole index, well inside the
hourly budget), and writes `_drafts/private/gh-contact-pivot.json` after each
batch; a rerun resumes. `rank` extracts platform accounts, LinkedIn profiles,
email addresses and WhatsApp numbers (`wa.me` links, read as the phone number
they name) with the shared normalizers and prints those the index lacks, with
where each was read.

Nothing is filed automatically. Before filing, hold back:

- LinkedIn and Facebook profiles, and addresses that read as a person's full
  name: they may belong to the real person a persona borrows.
- Company-domain addresses.
- README links that credit someone else (a roadmap, a template's author) or
  were copied with a profile-README generator; check that the handles in a
  contact block are the account's own.
- Values from an account created before 2020 or with more than 300 followers,
  unless it is already tied to a named persona: an established account in the
  index may itself be a false positive, and its contacts would publish a real
  person.

The first run (22 November 2026, 1,193 accounts read) filed 58 values and held
the rest in `_drafts/private/gh-contact-pivot-held.md`. Telegram accounts found
this way go on to `scripts/telegram-pivot.js` (`docs/telegram-pivot.md`).
