# Tool: discover-sources

## Purpose

`scripts/discover-sources.js` finds new candidate articles from the
publishers already trusted in `src/_data/iocs/scrape-sources.json`, before
anyone reads them, and queues the ones that look DPRK-related for a human to
review. It reads the RSS or Atom feed of each publisher listed in
`scripts/data/feeds.json` — or, where a publisher has no feed, its sitemap —
keeps the recent items that name a DPRK actor, campaign or malware family, and
drops anything already accounted for: a URL already in `sources[]`,
`not_scraped[]` or the discovery queue itself, or already read by the scraper
according to `scripts/data/scraped-sources.txt`. What is left is appended to
the `discovered[]` array in `scrape-sources.json`.

**Nothing it finds is scraped or published.** `scripts/scrape-dprk-iocs.js`
reads `sources[]` only, so an article sitting in `discovered[]` is never
fetched, extracted or ingested. A human moves an entry into `sources[]` with a
`publisher` and a `campaign` label to have the next scrape read it, or into
`not_scraped[]` with a `reason` to stop it being rediscovered — see
`docs/scrape-dprk-iocs.md` for what those two arrays mean and how the scraper
treats them. `discovered[]` is not read by any code path in the site build; it
is a to-do list.

## Shared code

The feed, sitemap and URL logic lives in `scripts/lib/feeds.js` — `parseFeed`
(RSS 2.0, RSS 1.0/RDF and Atom, tolerant of CDATA and namespace prefixes),
`parseSitemap`, `normalizeUrl` and `stripTracking`, `compileKeywords` /
`matchKeywords`, and `dedupeCandidates`. It has no dependency beyond Node
itself, matching the rest of the scraper. `scripts/lib/feeds.test.js` covers
it with table-driven tests; run `node --test scripts/lib/**/*.test.js` (or
`npm run test:unit`) after touching either file.

## Running it

```
node scripts/discover-sources.js                    # last 14 days, writes discovered[]
node scripts/discover-sources.js --since 30 --dry-run
node scripts/discover-sources.js --summary discovery-summary.md
node scripts/discover-sources.js --probe
node scripts/discover-sources.js --probe --publisher Genians
```

Flags:

- `--since <days>` — how far back an item's published date must fall to be
  considered (default 14). A sitemap entry with no article date falls back to
  the page's `lastmod`.
- `--dry-run` — read everything and print the candidates, but write nothing to
  `scrape-sources.json`.
- `--summary <path>` — write a Markdown summary (publishers read, items seen,
  new candidates in a table, failures, skipped publishers) to the given path.
  This is what the weekly workflow folds into the pull request body.
- `--probe` — instead of reading for candidates, find and verify each
  publisher's feed (see below) and, unless `--dry-run` is also given, write
  the result back into `feeds.json`.
- `--publisher <text>` — restrict either mode to publishers whose name
  contains the given text, case-insensitively. Useful with `--probe` when only
  one entry needs re-checking.
- `--timeout <seconds>` — per-request timeout (default 20).
- `--concurrency <n>` — publishers read at once (default 6).
- `--include-undated` — keep feed items that carry no date at all, rather than
  discarding them. Off by default because an undated item cannot be checked
  against `--since`.

Prints `DISCOVERED=<n>` as its last line of stdout, `n` being the number of
new entries actually written (0 on a dry run, even though the candidates found
are printed above it).

## The keyword filter

`feeds.json` carries two keyword lists that decide whether an item becomes a
candidate at all: `keywords`, matched case-insensitively and on whole words
(so `Konni` does not fire on `Konnichiwa`), and `case_sensitive_keywords`, for
a phrase like `IT worker` that would otherwise match constantly in ordinary
prose about what a tool does for a worker. A term written in a script with no
word spacing — the file also carries a handful of Korean terms — matches as a
plain substring instead, since a word boundary means nothing there. A match is
checked against an item's title, summary and categories together, so a term
that only appears in a feed's own category tag still counts. Add a term to
either list only once it is a name this corpus actually uses (see the keyword
discussion in `docs/scrape-dprk-iocs.md` for the same reasoning applied to the
scraper's own keyword gate); a term that fires on everything just adds noise
to review.

## Adding a publisher

Add an entry to the `feeds` array in `scripts/data/feeds.json`: `publisher`,
`site` (the page a human would read), and either `feed` (its RSS or Atom URL)
or, if it has none, `sitemap`. Leave `verified`, `note` and `status` for
`--probe` to fill in — set `note` by hand only for something a person needs to
know, such as the Medium caveat on the S2W entry or the Korean-language ASEC
feed that sometimes publishes before its English twin. A publisher with
neither a feed nor a sitemap is skipped with a log line rather than an error;
several government and sanctions pages in the file are listed exactly that
way, so a future feed or sitemap on the same page is not missed if `--probe`
is re-run against it later.

`--probe` is how an entry is verified rather than guessed at. For a publisher
with `feed` already set, it re-reads that URL and records whether it parses
and how many items it holds. For one with no feed, it fetches the site page,
reads every `<link rel="alternate">` it advertises, tries a short list of
conventional paths (`/feed`, `/rss.xml`, `/atom.xml` and similar, see
`KNOWN_FEED_PATHS` in `feeds.js`), and falls back to checking `robots.txt` and
the conventional sitemap locations if no feed is found anywhere. Run it after
adding a publisher, and periodically afterward — a blog platform migration or
theme change can silently break a feed URL that used to work, and `--probe`
is what would notice.

### Aggregators

An entry marked `aggregator: true` lists other people's reporting rather than
its own, and the queue never cites it. lazarus.day is the one such entry. Each
item in its feed ends its description with `| Source: <url> (<publisher>)`, and
discovery queues that URL under that publisher (`aggregatedItem` in
`feeds.js`); an item naming no source is dropped. Every item qualifies without
a keyword match, since the site lists only DPRK reporting. Its feed holds only
the last ten items, under a week at its rate, so the entry also names an
`archive` (`https://lazarus.day/reports/{year}/`, paged fourteen to a page,
newest first): discovery reads up to `archive_pages` pages (default 3), opens
each report page the feed did not carry for the original link in its
`<hgroup>` (`aggregatorReport`), and stops at the first page with nothing in
the window. On 2026-10-01 that was 39 reports read in twenty seconds, 24 in
the fourteen-day window and 21 not already known.

## What the weekly workflow does with it

`.github/workflows/scrape-dprk-iocs.yml` runs `discover-sources.js` before the
scrape itself, writing a discovery summary and printing `DISCOVERED=<n>`. The
scrape step runs regardless of what discovery found. The workflow opens a
pull request when either the scrape changed the ingested indicator set or
`DISCOVERED` is greater than zero, so a run that finds new candidate articles
but no new indicators still surfaces them for review rather than leaving them
silent in a data file nobody looked at. The PR body includes the discovery
summary's table of candidates, each with its published date, publisher, title
and matched terms, alongside the usual reminder that an entry only starts
being scraped once it is moved into `sources[]`.

A discovery failure (a feed timing out, a publisher blocking the request) does
not fail the job — `continue-on-error: true` on that step — because one
unreachable feed should not stop the scrape that follows it or the sync of
already-known sources.
