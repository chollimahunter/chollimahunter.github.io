# Telegram pivot

`scripts/telegram-pivot.js` reads the public `t.me/<handle>` page of every
indexed Telegram account and lists the contact values its display name and
bio give that the index does not hold. On 22 November 2026 the bio of
t.me/greenfoxfun, named in a KGJ organisation's README, read "GreenFox
pumpfun: https://x.com/greenfoxworld", which is how that X account was found.

```
node scripts/telegram-pivot.js collect [--limit N] [--force] [--extra FILE]
node scripts/telegram-pivot.js rank [--all]
```

`collect` reads one page a second, needs no account or key, and writes
`_drafts/private/telegram-pivot.json`; `--extra` adds t.me URLs listed one per
line in a file, such as new ones from `gh-contact-pivot.js` before they are
filed. `rank` extracts platform accounts, GitHub and LinkedIn profiles, email
addresses, WhatsApp numbers and bare `@handles` (read as further Telegram
accounts) and prints those the index lacks. Nothing is filed automatically.

A handle nobody holds still gets a page from t.me, with the title "Telegram:
Contact @handle" and the stock line "If you have Telegram, you can contact
@handle right away." Only a held handle's page carries the display-name block
(`tgme_page_title`); both this script and `enrich-platform-accounts.js` use
that block as the test. The enricher tested the title until 22 November 2026
and so recorded 88 unheld handles as live.
