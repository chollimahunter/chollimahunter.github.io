# Tool: sync-dtex-itworker-emails

## Purpose

Keeps the `dtex-i3-email-iocs` dataset inside
`src/_data/iocs/itworker-datasets.json` current against DTEX's public i3
Threat Advisory page, which publishes a live-maintained appendix of email
addresses associated with DPRK IT-worker operations.

## How it works

1. Fetches `https://www.dtex.ai/resources/i3-threat-advisory-inside-the-dprk/`.
2. DTEX's page renders each email through Cloudflare's standard email
   obfuscation feature (`data-cfemail="<hex>"`), which every visitor's
   browser decodes automatically via Cloudflare's own public JS on a normal
   page view — this is an anti-scraper measure, not an access control.
   Nothing about this tool bypasses a login, paywall, or robots
   restriction; it performs the same well-documented single-byte-XOR
   decode a browser performs for any reader.
3. Validates each decoded value against a basic email-format regex,
   separating valid entries from anything malformed in DTEX's own source
   data (a handful of entries have historically had a stray suffix like
   `-13` baked into the source table cell itself — these are excluded and
   counted in `excluded_count`, never guessed at or silently dropped).
4. Diffs the freshly-fetched, deduplicated, sorted list against whatever is
   currently stored, and overwrites the `dtex-i3-email-iocs` dataset object
   in place with the new list, updated `entry_count`, and a fresh
   `sync.last_synced` date.
5. Prints an added/removed summary and a final `CHANGED=true`/`CHANGED=false`
   line for the calling workflow to branch on.

## Running it manually

```
node scripts/sync-dtex-itworker-emails.js
```

## Running it on a schedule

`.github/workflows/sync-itworker-datasets.yml` runs this weekly
(Monday 06:00 UTC) plus on manual `workflow_dispatch`. If the script
reports `CHANGED=true`, the workflow opens a **pull request** with the
updated data file — it never commits directly to `main`. New/changed email
IOCs go through the same human-review-before-publish gate as every other
piece of content on this site, since these are unverified leads about real
email addresses (per DTEX's own disclaimer, presence on the list is not
proof of anything about the account holder) — a human should skim the diff
before it goes live, not just rubber-stamp an automated feed.

## Adding a second source dataset later

If another report publishes an equally-accessible, ungated bulk indicator
list (checked at build time: Microsoft's Jasper Sleet post and the UK
OFSI advisory were both reviewed and found to be narrative/guidance
without a concrete public indicator list — nothing was fabricated to fill
that gap), write a sibling script following this same pattern (fetch →
extract → validate → diff → write) that pushes a new dataset object with
its own `dataset_id` into the same `itworker-datasets.json` array, and add
a matching job to the GitHub Actions workflow. See `CONTENT_GUIDE.md`'s
"Add a new bulk IT-worker identifier dataset" section for the required
field shape.
