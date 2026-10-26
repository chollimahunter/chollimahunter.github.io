# Tool: scrape-dprk-iocs

## Purpose

Builds the searchable indicator index behind `/remote-workers/` by reading
the curated threat-intelligence sources listed in
`src/_data/iocs/scrape-sources.json` and extracting identity-focused indicators
— email addresses, GitHub accounts, LinkedIn profiles, and (under the much
stricter rules described below) npm packages and Chrome extensions — each
carrying the source it came from, the passage it appeared in, and when it was
pulled.

Three scripts, split along the line that matters for review: fetching is networked
and nondeterministic, merging is pure and reviewable.

| Script | What it does | Network |
|---|---|---|
| `scripts/scrape-dprk-iocs.js` | Fetches sources, extracts indicators, writes one run file per source to `_drafts/iocs/` | Yes |
| `scripts/ingest-scraped-iocs.js` | Merges staged runs into `src/_data/iocs/scraped-iocs.json` | No |
| `scripts/enrich-github-accounts.js` | Checks whether each indexed GitHub account still exists and mirrors its avatar | Yes |

Shared extraction, normalization and exclusion rules live in
`scripts/lib/ioc-normalize.js`, which `scripts/sync-dtex-itworker-emails.js`
also uses for its Cloudflare email decode.

## Running it

```
node scripts/scrape-dprk-iocs.js --all               # every unread source
node scripts/scrape-dprk-iocs.js --changed-only      # unread sources, then recheck read ones
node scripts/scrape-dprk-iocs.js --full              # re-extract every source
node scripts/scrape-dprk-iocs.js --source <url>      # one source, always re-read
node scripts/ingest-scraped-iocs.js                  # merge staged runs
```

`--timeout <seconds>` (default 45) bounds each request, `--concurrency <n>`
(default 4) sets how many hosts are worked at once, and `--budget <n>`
(default 250) caps how many already-read sources one `--changed-only` run
rechecks. A host is never sent more than one request at a time, and its
requests are a second apart.

`.github/workflows/scrape-dprk-iocs.yml` runs source discovery
(`docs/discover-sources.md`), then the scrape, then the ingest: weekly with
`--changed-only` and on the first of each month with `--full`. It opens a
**pull request**, never a direct commit, when the ingested set changed or
discovery queued new articles, so a human reviews every new identifier and
every new source before either goes live.

### Rechecking sources that have already been read

A published report is sometimes revised after it was read: a vendor appends
indicators, a researcher's list grows. `--changed-only` rechecks up to the
budget of already-read sources each run, oldest check first, so the whole
corpus is covered every few weeks. The request is conditional (ETag and
Last-Modified from the previous read), and a 304 or an unchanged hash of the
page's readable text ends the check without extracting. Only a source whose
text actually changed is extracted again and staged. Hashing the readable
text rather than the raw body is what keeps a rotated script tag or sidebar
from counting as a change.

The first recheck of a source read before hashes were kept records the
baseline and extracts nothing, so introducing the rotation did not re-ingest
the corpus. Wayback snapshots at a fixed timestamp never change and are never
rechecked. A recheck that fails still moves the source to the back of the
rotation and records `last_error`, so one dead page cannot hold the front of
the queue. The monthly `--full` run covers the other kind of change: an
improvement to the extractor reaches pages whose text has not moved.

## How extraction works

1. **Fetch.** Public pages only, honest user agent, one request at a time per
   host with a one-second delay, a 12MB body cap for HTML and 64MB for PDFs, HTML, plain text,
   Markdown and PDF. There is no
   crawler: the tool reads exactly the URLs in the data file. Open-ended
   crawling was the largest single source of false positives in the
   proof-of-concept this replaces.

   Markdown is accepted because of one publishing platform rather than one
   source. An Obsidian Publish site -- haydenmckenzie.com is the first here --
   answers every request to its own domain with a 2.6KB JavaScript loader
   carrying no prose at all, and serves the readable text as Markdown from
   `publish-01.obsidian.md/access/<site-id>/<path>.md`. That file URL is what a
   source entry names. The site id and the list of every page the site
   publishes come from two endpoints the loader itself calls:

   ```
   curl -s https://<site>/ | grep -o 'siteInfo={[^}]*}'   # the site id
   curl -s https://publish-01.obsidian.md/cache/<site-id> # every published path
   ```

   The cache listing is how a later pass finds pages added since, which
   matters for a site whose per-persona notes grow. Naming the file URL
   rather than the page has two costs worth knowing: the citation a reader
   clicks is the raw Markdown, not the rendered page, and the file is named
   after the note's title rather than its permalink, so renaming a note moves
   it. On 23 September 2026 haydenmckenzie.com renamed its three reports; the
   public pages kept their addresses and the old file URLs began answering
   "Not Found". The `permalink:` line in each file's front matter is how to
   match a renamed file back to the page.
2. **Refuse a page with no DPRK term on it.** A safety net under the human
   curation: `keywords` in `scrape-sources.json` lists the names this corpus
   recognises, and a page carrying none of them is refused rather than
   extracted. It has to cover the names vendors actually use, not just the
   obvious ones -- while it listed nineteen, a report writing only "BlueNoroff"
   was rejected as not DPRK-related. It now carries the cluster names
   (Lazarus Group, Kimsuky, Andariel, TraderTraitor, the Sleet series) and the
   malware families this corpus indexes under (BeaverTail, InvisibleFerret,
   JADESNOW, NukeSped). "Lazarus Group" is two words on purpose: a bare
   "lazarus" is also a Pascal IDE and a common surname. It also carries five
   Korean-script terms -- 북한, 조선민주주의인민공화국, 라자루스, 김수키 and
   안다리엘 -- because the Korean vendors and the ROK government publish in
   Korean, and a page about 북한 IT 인력 carries none of the romanised names.
   Five MOFA announcements and the Korean-locale twin of a Genians report were
   refused for exactly that until the terms were added. 북한 is the term every
   one of them carries, and it also appears in site navigation on Korean
   government pages, which is acceptable for a safety net that sits under
   human curation of the source list.
3. **Decode and defang.** Cloudflare `data-cfemail` values are decoded in place,
   and bracketed defanging (`hxxp`, `evil[.]com`, `user[at]mail[.]com`) is
   normalized before extraction. Bare-word defanging (" dot ", " at ") is
   deliberately not rewritten — it occurs in ordinary prose far more often than
   in indicators, and rewriting it would corrupt the quoted context.
4. **Extract from prose only.** A report's outbound links are never treated as
   indicators. They are navigation, author bios and citations — harvesting them
   turns a publisher's own GitHub org and every researcher it credits into
   "indicators". Real IOCs are written as text precisely so they are copyable
   and not clickable.
5. **Normalize.** `github.com/User/Repo` and `github.com/user` both resolve to
   `https://github.com/user`; LinkedIn URLs collapse to
   `https://www.linkedin.com/in/<slug>/` regardless of country subdomain,
   tracking parameters or `/details/...` suffix. This is what makes
   deduplication across sources work at all.
6. **Exclude.** Host matching is by suffix, and every seed host is excluded
   along with its subdomains, so a source's own boilerplate never becomes an
   indicator. Also excluded: role addresses (`press@`, `info@`, `noreply@`),
   asset and CDN URLs, social boilerplate, and private, loopback, reserved and
   documentation IPv4 ranges.

   Four more exclusions exist because each was a real false positive, and each
   is the same mistake in a different disguise -- publishing the person doing
   the reporting, or the person reported on as a victim:

   - **The publisher's own address on somebody else's mail host.** A source
     signs its post with its own domain spelled as the local part of an address
     elsewhere: `kmsec.uk` uses `kmsec-uk@proton.me`, `chollima-group.io` uses
     `chollima_group@proton.me`. Compared against every seed host with
     separators removed, and against the host with its suffix dropped -- the
     latter length-limited, so that `okta.com` does not make `okta@` unusable.
   - **The author of a source hosted on a code platform.** When the source *is*
     a GitHub page the publisher is a path segment rather than a host, where no
     host check can see it. Accounts owning a seed URL are refused on
     GitHub, GitLab and Bitbucket hosts.
   - **A package manifest's link to its upstream project.** npm renders a
     package's `bugs` field as `<repo>/issues` and its `homepage` as
     `<repo>#readme`, and a report dumping a malicious release's metadata copies
     both into its table. In an impersonation those name the project being
     impersonated: a feed listing malicious releases produced
     `github.com/mcollina`, who maintains thread-stream and pino. An indicator
     table has no prose, so the victim-context gate cannot see this one.
   - **Everything after a reference list.** A bibliography usually carries no
     heading, so its entries inherit the article's last real section and the
     chrome check misses them. Extraction stops at the first line that is only
     "References", "Further Reading", "Bibliography" or "Works Cited".
   - **Other articles hidden in the page.** Darktrace renders the full text of
     its latest posts, hidden by CSS, below every article, and the set rotates
     weekly. Both Darktrace DPRK sources were credited with 28 values each from
     Mirai, Mexican-government and China-linked cases before this was caught
     (October 2026). `CONTINUATION_MARKERS` in `scrape-dprk-iocs.js` lists the
     containers the page is cut at; the values already ingested sit in each
     source's `exclude`, because ingest does not retract a value a newer run
     no longer finds.

   A fifth kind of exclusion is curated per source rather than written as a
   rule. A source entry may carry `exclude`, a list of values the page names
   that are not indicators, each with its reason:

   ```json
   "exclude": [
     { "value": "https://github.com/example-maintainer",
       "reason": "The compromised maintainer's own account, printed in the report's suggested git clone command." }
   ]
   ```

   `npm run seal` then moves the readable entry to the private checkout
   (`_drafts/private/exclusions.json`) and leaves `{ "sealed": "<sha256 of the
   lowercased value>" }` here, which is all extraction and ingest compare
   against (`scripts/seal-private-lists.js`).

   This exists because the generic rules catch a class of mistake and some
   mistakes are one value in one report, where the report itself is the reason.
   Jamf's Contagious Interview write-up names a Telegram bot belonging to the
   web3 project sharing the C2 host and stops short of calling the project a
   front; Socket's Packagist report prints the compromised maintainer's
   repository in a mitigation command; Igloo's analysis lists a LinkedIn
   profile from the operators' own spreadsheet without saying whether it is a
   persona or a borrowed identity. Before this list existed the choice was to
   take the source with the victim in it or hold the whole source and lose the
   indicators around it, and Igloo was held for that reason. The value is
   compared case-insensitively against the normalised form, so write it as the
   run file would.

   Exclusions are re-applied on every ingest, not only at extraction. A rule
   written today would otherwise stop tomorrow's harvest and leave yesterday's
   records untouched, which is how two researchers' contact addresses sat in the
   published index until the rule that recognises one was written.
   **Tables rendered one cell to a line.** Some vendors (eSentire, Sysdig)
   print an appendix as `Domain`, the value, then `EtherRAT C2`, each on its own
   line. No heading precedes such a row and no algorithm label sits beside a
   digest whose type cell says only `File`, so the heading walk and the
   proximity windows found nothing, and ten domains and eight digests of one
   eSentire post went unfiled. `typedTableRow` in `ioc-normalize.js` reads the
   type cell above and the description below: a domain or URL is taken when the
   description says C2 or malware and does not say compromised, legitimate or
   download; a digest is taken on its `File` or hash type cell, with the victim
   question asked of the row's own cells rather than a window that reaches the
   previous row. An Ethereum address labelled a smart contract, in a type cell
   or by the words before it, is filed as `smart_contract_address` rather than
   `wallet_address`. Rendered code blocks that print `http: //host` are closed
   up to `http://host` before extraction.

7. **Capture context.** A quote snapped to word and sentence boundaries. Where a
   value sits inside an IOC appendix table rather than a sentence, the window is
   just neighbouring indicators, so it is recorded with **no quote** and the
   citation alone carries the meaning. Quoting it would be noise dressed as
   evidence.

## PDFs

The most authoritative sources here are PDFs — UN and multilateral sanctions
reports, government advisories — and they hold the annexes that actually list
addresses and aliases. `scripts/lib/pdf-text.js` reads them with no dependency
beyond Node's `zlib`, because the repo ships no runtime dependencies and the
workflow runs `node scripts/…` with no install step.

It returns page text with each font's `/ToUnicode` map applied, so subset-
embedded fonts come out readable rather than as glyph indices. Two behaviours
are worth knowing when reviewing a PDF run:

- **No headings.** A PDF heading is a run of text in a bigger font, and
  inferring one from glyph sizes would be a guess, so `headings` is empty and
  every indicator from a PDF lands unlocated. The victim-section guard trusts
  heading labels, so inventing them would be worse than having none.
- **Hyphens are rejoined.** Typesetters draw a hyphen as its own positioned run,
  which lands it on a line of its own. Left alone, MSMT 2025/2's
  `linkedin.com/in/lai-we-wang-ba355a1a2` extracted as `/in/lai` — a wrong
  indicator rather than a missing one. `rejoinHyphens` puts them back.

The cap for a PDF is 64MB rather than 5MB; a hundred-page report with embedded
fonts and figures clears 5MB easily, and the Panel of Experts' final report
(S/2024/215) is 615 pages and 47MB. A PDF whose text is only in scanned images
fails with a message saying so. There is no OCR and should not be.

## GitHub account status and avatars

`scripts/enrich-github-accounts.js` walks every `github_profile` record and
records `account_status`: `live` or `removed`, the date checked, and a locally
mirrored avatar.

```
node scripts/enrich-github-accounts.js          # only accounts not yet checked
node scripts/enrich-github-accounts.js --force  # re-check everything
```

It uses `github.com/<login>` and `github.com/<login>.png` rather than
`api.github.com`, because the API allows 60 unauthenticated requests an hour —
roughly seven hours for the accounts currently indexed — while the web
endpoints answer the same two questions with no such cap. The avatar is
mirrored locally because the site forbids external image dependencies.

**An avatar is not evidence of who operates an account.** DPRK IT-worker
personas routinely use stock imagery or photographs taken from uninvolved real
people, so a face shown here may belong to someone with no connection to these
operations. Every avatar on the site carries that wording next to it. Treat the
account as the indicator; the picture is only what the account chose to display.

`removed` is a genuinely useful signal in its own right — an account taken down
since it was reported is corroboration that someone acted on it.

After the scraper's records, the same run covers every GitHub login in the
three dossier files (`x-dossiers.json`, `third-party-registries.json`,
`direct-observations.json`) and writes `scripts/data/github-account-status.json`,
which `scripts/lib/dossiers.js` attaches at build time. That phase asks
`gh api users/<login>` for the account's creation date: an account created
after the earliest date the dossiers give the login (its `first_seen` or a
cited source's publication date) cannot be the one the report named, and is
recorded as `recycled`, with both dates and no avatar. Without `gh` the phase
falls back to the web endpoints and cannot detect recycling.

### Commit emails and linked websites

`scripts/enrich-github-emails.js` looks for the operator's own contact points on
accounts that are still live. It reads `scripts/data/github-account-status.json`
(the output of `enrich-github-accounts.js`, so run that first) for the set of
live logins, and the `github_profile` indicators in `x-dossiers.json`,
`third-party-registries.json` and `direct-observations.json` for the dossier
accounts. For each account it takes the website linked on the profile and the
author address on commits in the account's own (non-fork) repositories, up to
three commits in each of the first eight repositories, and stops early once one
address has appeared three times. Addresses matching `noreply`, bots and
`@github.com` are dropped, and the rest are ranked by how often they recur.

```
node scripts/enrich-github-emails.js               # live dossier accounts not yet done
node scripts/enrich-github-emails.js --live-all    # every live account
node scripts/enrich-github-emails.js --logins a,b  # named accounts, re-fetched even if done
node scripts/enrich-github-emails.js --limit 40    # first 40 of the selected accounts
```

It writes `_drafts/private/github-emails.json`, keyed by login, with the linked
`site`, a ranked `commit_emails` list and `likely_operator_email` (the top
address, or null). It never edits the indicator files: whether an address
belongs to the operator, rather than to an upstream author of copied code, is a
reviewer's call. Like the status script it uses github.com web endpoints rather
than the API, spaces requests by at least 120 ms, doubles the gap on a 429 or
403, and stops the batch after three such responses in a row; the file is saved
every ten accounts, so a stopped run resumes where it left off. Run it after new
dossier accounts are filed or after a status sweep changes which are live.

## LinkedIn account status and photos

`scripts/enrich-linkedin-accounts.js` writes the same `account_status` shape
onto every `linkedin_profile` record, so both platforms render identically.

```
node scripts/enrich-linkedin-accounts.js
```

Unlike the GitHub script, this one performs no network access. It applies the
observations recorded in `scripts/data/linkedin-account-status.json`, because
the check itself cannot be automated: an anonymous request to a LinkedIn profile
returns HTTP 999 behind an authwall, and a same-origin `fetch` from a signed-in
session returns only the single-page-app shell. What does work is loading the
profile in an iframe in a signed-in browser and reading the iframe's final URL —
LinkedIn redirects a removed profile to `/404/`, so a final URL still on
`/in/<slug>/` means live. Photos are downscaled to 128px in the page before
being saved to `src/assets/img/linkedin/`.

Two conditions govern re-running it, and both must hold:

- **The session must be in LinkedIn's Private mode** (verify at
  `linkedin.com/mypreferences/d/profile-viewing-options`). Viewing a profile
  otherwise notifies its owner, and many of these slugs are stolen identities
  belonging to uninvolved people who should not be told they are being examined.
- **The photo is not evidence of who operates the account.** It is more likely
  to be a stolen or generated image here than on GitHub, which is precisely why
  it is worth showing: a reader who recognises the face can report a false
  positive. Every photo carries that wording next to it.

Because it is a manual step, it is not part of any workflow and does not run in
CI. Split this way, the browser session produces observations and the script
makes a reviewable diff out of them.

As of the last run, 2026-09-10: 6 of 51 accounts live, 45 removed. The one
account found live that day, hailong-jin-906375118, only serves its photo at
100 pixels square: LinkedIn signs each size of a profile image separately, and
the larger sizes answer 403 for an image uploaded in 2018, so the mirrored copy
is the size the page itself shows. A live account showing LinkedIn's generated
initial in place of a photo has nothing to mirror.

## Polarity: why packages and extensions are handled differently

A report about malicious npm packages also names the legitimate packages they
impersonate. A report about a wallet-stealing payload lists the extension IDs of
the wallets it **targets** — Keplr, MetaMask, Phantom. A pattern match cannot
tell those apart, and getting it wrong means publishing MetaMask's extension ID
as a "DPRK indicator", which defames a legitimate project.

So package and extension indicators must clear three gates, not one:

1. an explicit registry or Web Store URL, never a bare name in prose;
2. surrounding text that **positively** states the artifact is hostile
   (`malicious`, `compromised`, `trojanized`, `typosquat`, and similar);
3. no victim language nearby (`targeted`, `vulnerable`, `legitimate`,
   `impersonates`, and similar).

Requiring a positive statement rather than merely filtering negatives is
deliberate. In a long appendix list, the heading reading "targeted wallet
extension IDs" sits far outside any sensible window from the twentieth id
beneath it, so a negative-only filter silently passes the ones at the bottom.
The positive requirement fails closed: the index under-reports rather than
accuses.

The consequence is that **very few package indicators come from scraping**, and
that is the correct outcome. The hand-curated rulesets
(`src/_data/iocs/repo-scan-ruleset.json` and `etherhiding-watchlist.json`) are
the right home for these types — a human decided the polarity of every entry —
and `src/_data/iocIndex.js` folds them into the same search index carrying the
strongest provenance label. Add a malicious package there, not here.

## Activity clusters

Each source carries a `campaign` — the DPRK activity cluster it reports on
(`IT Worker Fraud`, `Contagious Interview`) — which is applied to every
indicator drawn from it and shown as a chip on the page and as a search filter.

It is curated per source rather than inferred from the page. A report can name
several cluster names while reporting on one, and guessing wrong mislabels every
indicator that source contributes.

## The grounding check

The ingest confirms every extracted value appears literally in the page text
captured with the run that claims it. A value that fails is **rejected, not
flagged**: an indicator absent from its own cited source has no citation, and an
uncited claim about a real person is the one thing this site's methodology
exists to prevent (see `CONTENT_GUIDE.md`).

Regex extraction passes this by construction. The check exists for
model-assisted extraction, where a fabricated but well-formed address with an
invented supporting quote would otherwise be indistinguishable from a real
finding.

Note what this check does and does not establish. It confirms a source said the
thing. It does not confirm the thing is true.

## AI mode

`--ai` is recognized and deliberately not implemented. The proof-of-concept's
evidence-pack design is worth keeping — it sends the model only pre-extracted
candidates and snippets rather than the whole page, with a prompt-injection
guard — but it had no grounding check of any kind, and merged model output into
the same store as regex output with no provenance flag. A fabricated address
with a fabricated quote was indistinguishable from a real finding.

Before AI mode can be enabled it must:

- stamp every record `extraction.method: "llm"` with the model named, so the
  page can label it (the data model, templates and search UI already handle
  this — see the `AI-EXTRACTED` badge);
- pass every value through the grounding check above, with no exception;
- run only on demand, never in CI, since it needs a credential the scheduled
  workflow does not have.

Use the Anthropic API rather than the proof-of-concept's raw OpenAI transport,
and a current Claude model.

## Adding a source

Add an entry to `src/_data/iocs/scrape-sources.json`. That is a content edit,
not a code edit — the host is automatically added to the exclusion list, and the
source appears on `/sources/` once its indicators are ingested.

Sources that return 403 or 404 are skipped. A failed source is not
recorded as seen, so it is retried on the next run rather than silently dropped.
PDFs are supported — see the PDFs section above, `scripts/lib/pdf-text.js`
and `parsePdf()` in `scrape-dprk-iocs.js` — and are not skipped on that basis
alone; `CONTENT_GUIDE.md`'s reviewed-but-not-seedable guidance covers only a
PDF that cannot be reliably parsed.

### Finding sources worth adding

`lazarus.day` is the most efficient index for this, and it is worth being
clear about what it is: an aggregator, not a source. Its report pages carry a
short summary, a set of topic tags and a link to the original article on the
publisher's own site, and no indicator section at all. Scraping those pages
would therefore yield very little, and what it did yield would be cited to a
middleman rather than to whoever did the work. One of its report pages sits in
`scrape-sources.json` for historical reasons; nothing else from the site
should be added.

That paragraph was written about the report pages and is still true of them.
It is not true of the whole site, which this document did not know until
2026-09-11: `lazarus.day/iocs/` is a standing indicator index holding 33,352
values, a good deal larger than everything this repository has gathered. By
type it is 12,478 hashes, 8,147 domains, 6,077 IPv4 addresses, 4,011 URLs,
1,369 email addresses, 964 ASNs, 222 YARA rules and 84 wallets, filterable at
`/iocs/?category=<type>` and paged from there. Every value has a page of its
own carrying first and last seen dates, enrichment for the addresses, and a
**Related Reports** list linking the report it came from, which in turn links
the publisher's own article. The middleman objection is therefore solvable:
provenance is two fetches away from any value.

**What is not solvable by fetching is the reason to hold it.** Every one of
those pages carries the site's own warning, verbatim: "These IoCs were
automatically extracted using regular expressions or an LLM and may include
non-malicious data." That is an aggregator declaring its index unvalidated, in
the two failure modes this repository has spent the most effort on — the
regex false positive, and the model-extracted value with nothing grounding it.
The AI-mode rules above exist precisely so that a value extracted by a model
is labelled as such and checked against the page it came from; a value
extracted by somebody else's model, which they do not claim to have checked,
has neither. Ingesting it wholesale would multiply the corpus by six with
material the publisher does not vouch for, and the pages would still read as
though this site had.

So it stays out for now, and the decision is worth taking deliberately rather
than by omission. If it is ever taken up, the shape that would work is narrow:
pull only the types this repository carries, resolve each value to the
original report rather than citing the aggregator, and treat lazarus.day's row
as a pointer to be confirmed against the publisher's own indicator table
rather than as the citation itself. That is the same standard every other
scraped source is held to. Note also that the site is published CC BY-SA 4.0,
so reuse carries an attribution and share-alike condition that does not apply
to the vendor reports this corpus is otherwise built from.

2026-09-12: that narrow version was taken up, one category at a time, and it
works as described. The mechanics: the category listing at
`/iocs/?category=<type>&page=N` (fifteen values a page; the IPv4 key is
`ipv4`, since `ip` returns every type) gives each value's page, whose Related
Reports timeline names the aggregator's report page, whose one outbound link
is the publisher's article. Diff the values against every file under
`src/_data/iocs/`, resolve only the missing ones, group them by original
article, and register each article in `scrape-sources.json` with the cluster
its tags name; the scraper then reads the publisher, and the keyword gate,
the exclusion rules and a reading of every run decide what ships. Nothing is
cited to lazarus.day. What the walk turned up is worth knowing before the next
one: a fair share of the aggregator's values are its own extraction damage,
words glued onto real addresses (`byjasonsaayman@`, `feedcorvettdan1963@`)
and first characters dropped, which the publisher's page does not carry and
which therefore cannot be grounded; a third of its IPv4 values have no related
report at all; and its report links for a client-rendered or hostile host
resolve to the same shell the scraper already refused, so those go through
the Wayback Machine or a prerendered asset as the two quirks below describe.
The emails came first (1,365 in the index, 287 missing, 89 grounded), then the
wallets (76, 32 missing, the missing ones all heist post-mortems, which need
reading for the victim's side of the ledger), then IPv4 and domains.

Its value is the tag index. `lazarus.day/tags/itworker/` listed 263 reports
across 126 distinct publishers when it was last enumerated, paginated as
`?page=N`, and each entry names the publisher and links the original. Walking
that list against the publisher names already in `scrape-sources.json` is the
fastest way to see what is missing. The same applies to its other tags:
`famouschollima`, `jaspersleet`, `nickeltapestry`, `pikvm` and the rest.

Nine of those other tags were walked on 2026-09-10: `famouschollima`,
`jaspersleet`, `nickeltapestry`, `pikvm`, `contagiousinterview`,
`contagioustrader`, `tinypilot`, `deepfake` and `purpledelta`, 254
entries in all. The tag pages link lazarus.day's own report page, and the
original sits in the first outbound link of that page's `<main>`, so
resolving an entry to a URL is one more fetch. Diffed by URL against
`sources[]`, `not_scraped[]` and the seen list, 49 were new. Every one was
fetched and its run read before anything was decided, and the shape of the
result is worth knowing before the next walk: ten earned an entry, contributing
33 indicators; 23 fetched cleanly and yielded nothing, being narrative,
advisory or period-summary pieces; two yielded only the author's or the
reporter's own address; two aggregated other vendors' indicators that were
already indexed from the originals; and seven failed to fetch. All of it is in
`not_scraped[]` with reasons. The espionage tags were left for the
cluster-label work, and were walked on 2026-10-01 once it had landed.

They now redirect: `/tags/kimsuky/` answers 302 to `/actors/kimsuky/`, and
the actor pages are what to walk, paged with `?page=N`, about fourteen reports
a page. Past the last page the site serves the last page again rather than an
empty one, so a walk has to stop at the first page with nothing new. Every
actor was walked: Kimsuky (274 reports), Konni, APT37, Andariel, APT38,
BlueNoroff, Lazarus, and the alias pages (Famous Chollima, Hidden Cobra,
ScarCruft, APT43, APT45, Group123 and the vendor APT-Q and ATK series).
Roughly two thirds of what they list was already known here. The rest, about
450 articles, was read and filed in #20 to #25: 78 sources and some 390
indicators, the rest declined with reasons. Labels follow the actor page,
mapped to this site's clusters (Famous Chollima to Contagious Interview,
APT43 to Kimsuky, APT45 to Andariel, ScarCruft and Group123 to APT37, Hidden
Cobra and BlueNoroff to Lazarus Group and APT38), except where an article's
own text names a narrower campaign.

Three things recur in what these pages link to and are worth checking every
time. Government malware reports reproduce WHOIS blocks, so every registrant
and abuse address in a CISA analysis report has to be excluded; a multi-actor
quarterly report (ESET's) carries values from other countries' sections; and
a conference deck on GitHub is a PDF served as application/octet-stream,
which the scraper now reads when the path ends in .pdf. About a hundred of the
linked articles no longer fetch (403, 404, scanned PDFs) and are not declined,
so a later Wayback pass can still pick them up.

Two cautions when working from it. Report volume is not indicator density —
the publisher with by far the most entries under that tag is the US Department
of Justice, whose press releases are largely narrative, so a candidate has to
be checked for atomic indicators before it earns an entry rather than being
added on its report count alone. And a good number of the names in that index
are individual researchers rather than firms, which usually means an X account
and a hand-transcribed dossier under `docs/x-dossiers.md` rather than a scrape
source; browsercookies, tanuki42, zachxbt and meow_mfer all arrived that way.

### Two source quirks worth knowing

`northscan.co` is a Next.js app whose article URLs render an empty shell to a
plain fetch — thirteen kilobytes of JavaScript and no content. The prerendered
markup is served at the same path with a `.html` suffix, and that is what the
source entry points at: 2.3 MB of real content carrying the indicators. Check
for the same pattern on any source whose fetched body is far too small for the
article it claims to be.

OFAC designations go in one page at a time rather than by pointing at
`ofac.treasury.gov/recent-actions`, because that index paginates and this
scraper takes explicit article URLs. Each designation of a DPRK IT-worker
facilitator carries a structured email field in plain text with no Cloudflare
obfuscation, so a new designation earns an entry of its own when one lands.

## State and staging

- `_drafts/iocs/*.json` — one run file per source. Gitignored: these are
  transient inputs, and the reviewable artifact is the resulting diff in
  `src/_data/iocs/scraped-iocs.json`.
- `scripts/data/scraped-sources.txt` — tracked in git, so the already-read list
  persists across runs. Delete a line to have that source re-read.
- `scripts/data/scrape-state.json` — per source, the ETag, Last-Modified and
  readable-text hash of the last read, and when it was last checked. The
  workflow carries it between runs in the Actions cache; a merged sync PR
  refreshes the checked-in copy, which is the fallback when the cache has been
  evicted. Delete an entry to have that source re-baselined.

## What the site does with the output

`src/_data/iocIndex.js` merges `scraped-iocs.json` with the bulk datasets in
`itworker-datasets.json` into one list, deduplicating on type and value so an
indicator reported by two sources becomes **one record carrying both
citations**. `src/ioc-index.njk` emits a compact, source-normalized version of
that list to `/assets/data/ioc-index.json`, which `src/assets/js/ioc-search.js`
downloads and searches in the browser.

## The espionage ingest, 2026-09-11

The decision recorded under "Next" was implemented. `Kimsuky`, `APT37`,
`Konni`, `Lazarus Group`, `APT38` and `Andariel` are campaign labels now, the
four espionage clusters that already had taxonomy entries carry
`indicator_campaigns`, two more clusters were written for APT37 and Konni, and
the Reconnaissance General Bureau page takes all of them because it is the
organisation the rest sit under rather than a cluster beside them.

116 sources went in, from walking the `lnk` and `cryptocurrency` tags. The
label on each was not guessed from its slug: every staged run was searched for
the actor names and their vendor aliases, and a source carries the leading
actor plus any other the article names at least a quarter as often, which is
why a good number carry two. 22 further sources yielded indicators and named
no actor at all -- mostly Korean malware analyses and exchange-hack writeups
where the attribution lives in other reporting -- and they are left out rather
than filed under a label their own text does not support.

**Every domain from the batch is held.** This document has said since the
domain extractor was built that the gate cannot tell an operator-registered
domain from a compromised third-party site under the same C2 heading, and that
settling it is a review step. This is the first ingest at a scale where that
bites, and the output proves the point: 36 domains, among them a national
police service, a human-rights commission, a web hosting company, a dozen
small-business sites that read as compromised staging, and one string,
`com.hyundaipay.hdac`, that is an Android package name and not a domain at
all. Publishing that set would assert that a police force runs DPRK
infrastructure. They sit in `exclude` on the seven sources that produced them,
with the reason, so a re-run does not put them back and a reviewer can work
through them one report at a time. Nothing else from those sources is
affected: a hash, an address or a filename makes no claim about who owns
anything.

The Android package name was a real extractor defect rather than a judgment
call, and is fixed. Reverse-DNS is not DNS: a package name and a bundle
identifier are dot-separated labels in the opposite order, so they satisfied
every rule `normalizeDomain` had. The guard needs two things true together --
the leftmost label is one no hostname leads with, and the rightmost label is
not a top-level domain. Testing only the first would have thrown away
`dev.azure.com` and `me.example.org`, which are ordinary hosts. The value is
off the exclude lists, because those are for judgment calls and this was a
bug.

## Reviewing the held domains

The 36 domains the espionage ingest produced have been read one report at a
time, which is the review step this document says the gate cannot do for
itself. Seven are published and 29 stay held, and the split is cleaner than
expected, because the two kinds sit in visibly different lists.

**Released: dynamic-DNS hostnames.** Every domain Kaspersky lists under "C2
address used by backdoor" in its Bluenoroff write-up is a subdomain of a free
provider -- `linkpc.net`, `publicvm.com`, `dnsrd.com`, `digmoo.com`. A
compromised bakery does not have a `linkpc.net` hostname; an operator
registers one in a minute. That is the shape to look for: where the provider
is the registrar of last resort, control is not in question.

**Held: somebody else's website.** The Genians Konni list is the opposite
pattern and unmistakable once seen -- a run of unrelated small-business and
institutional sites in one C2 block, a national police service and a
human-rights commission among them. That is the cluster staging payloads on
sites it broke into, and naming them as operator infrastructure would name the
victim as the attacker. The Logpresso pair carries the evidence on its face:
the URL beside the domain is a `wp-admin` path.

Two are held on their own terms. SentinelOne annotates its pair as "VPS
overlap (moderate confidence)", which is the publisher declining to assert it,
and this site does not firm up an attribution its source left soft. And
`msservices.hxxps443.org` is a transcription question rather than an
attribution one: the page writes the parent as `hxxps443.org`, which is either
a provider's real name or `https443.org` defanged somewhere the refanger does
not look, since defanging normally only touches the scheme. Printing it as
written would record a domain that may not exist; refanging it would invent
one.

Every held case keeps the hashes, addresses and filenames from the same
indicator block published, because none of those claims to say who owns
anything.

## Operator passwords

Operator passwords are tracked and published. A password an operator account
used is worth having in two ways: two accounts that logged in with the same
one are very likely one operator, and the string itself is something a
defender can search logs, dumps and other reporting for. Until 28 September
2026 the site kept passwords out, blanking any quoted passage that held one
and recording reuse only as a hash; that rule was dropped at the maintainer's
direction.

Quoted passages are now kept as the source printed them, password included.
The Raven File write-up's sample table pairs operator addresses with passwords
from an infostealer log. `scripts/build-password-links.js` reads it and writes
`src/_data/iocs/password-links.json`: `passwords` maps each address to the
password it was reported with, and `clusters` groups the addresses that share
one under a short fingerprint (sha256, first twelve hex) used as a stable
cluster id. `iocIndex.js` attaches `password`, `password_group` and
`password_siblings` to each email record; the indicator page shows the
password and the accounts that reused it, and both the password and the
cluster id are searchable. Re-run the builder whenever the Raven File source
is re-scraped.

A table of this kind can hold a victim's address as well as an operator's.
Only an address already indexed as an indicator shows a password, so the rules
that keep a victim out of the index keep their password out too.

## Auditing a batch before it ships

`node scripts/audit-indicators.js` flags scraped indicators that look like
they belong to somebody other than an operator. Run it after an ingest and
before believing the numbers. `--since YYYY-MM-DD` narrows it to one batch.

It exists because the guards in `ioc-normalize.js` are denylists of specific
observed false positives, and they carry a standing instruction to add only
what has actually been seen in output. That instruction is right and it means
those lists are permanently one batch behind. Two consecutive batches proved
the cost: the first indexed three Plainbit team addresses, PolySwarm's contact
inbox and the OFAC address readers are told to send tips to; the second
indexed Microsoft's and Ably's GitHub organisations and the Medium account of
a protocol DPRK stole from. Both were found by a person searching the site's
own pages afterwards.

The audit flags three shapes: a mail domain or account handle matching a
source publisher's own, a role address such as `info@` or `threatintel@`
where a person's name should be, and victim language in the sentence the value
was quoted from. It deletes nothing. Every rule has real false positives -- the
first run flagged ten and four were genuine operator values, including two
addresses a phishing mail was *sent from* in a sentence that also used the word
"impersonating" -- so the output is a short list for a reviewer rather than a
verdict.

### Four things the first run found

**A vendor's research domain is not its blog's domain.** The source-host guard
compares against the URL being scraped, so `securelist.com` never matched
`intelreports@kaspersky.com` and `welivesecurity.com` never matched
`threatintel@eset.com`. Both domains are on the denylist now.

**The impersonated developer is in the same table as the impersonator.** A
Microsoft write-up of an npm scope takeover prints the legitimate package
beside the malicious one in two columns, and the extractor read both. The real
maintainer's address is held with the reason; the malicious column is
published.

**A drained wallet is the victim's.** QuillAudits describes an admin hot wallet
that funds were taken *from*. A wallet record here asserts operator control, so
publishing it inverts the finding. The addresses the funds moved *to* stay.
The opposite case is in the same audit output and stays published: rekt.news
writing that an operator "drained a total of $54.3M via the following
addresses" is naming the operator's own wallets.

**Removing a record does not remove it.** The ingest merges every staged run,
so a value deleted by hand from `scraped-iocs.json` comes straight back on the
next run. Three of these came back twice. Three things now stop that: a re-run
of the source after fixing the guard, `exclude` on the source entry for a
judgment call, and the ingest honouring `not_scraped[]`, which it previously
did not -- a source could be read during triage, recorded as declined, and have
its staged run ingested anyway. Keep one run per source; a re-run writes a new
file beside the old one and the stale copy is what feeds the value back.

### Every record carries a cluster label now

Registering a source is not optional. `--source` takes a bare URL, so a
candidate read during triage produces a run with `campaign: []`, and
everything it yields lands in the index under no label: invisible to every
cluster filter and missing its publisher on `/sources/`. 268 records were in
that state before this pass. 30 of those sources are registered with labels
grounded the same way the espionage batch was, 33 name no cluster or campaign
anywhere in their text and are declined rather than filed under one this site
picked for them, and the 160 records left with no citation this site stands
behind are gone. The count to watch is zero:

```js
records.filter((r) => !(r.campaign || []).length).length
```

## Structural checks

`node scripts/audit-integrity.js` is the companion to the audit above: that one
asks whether a value belongs to an operator, this one asks whether the data is
internally consistent. It reads `scraped-iocs.json`, `scrape-sources.json`, the
dossier files under `src/_data/iocs/`, the persona images under
`src/assets/img/personas/`, the merged index from `iocIndex.js` and, when a
build exists, `_site/assets/data/ioc-index.json`. It writes nothing; it prints
either "No integrity problems found." or a list of findings. It takes no flags
other than `--help`.

The checks cover duplicate or publisher-less or campaign-less sources, a URL in
both `sources[]` and `not_scraped[]`, a declined source with no reason, duplicate
record ids, records or citations with no source, URL or context quote (a context
blanked on purpose is treated as redacted, not missing), a `record_count` that
disagrees with the records, values that no longer normalize to themselves,
dossier photographs missing from the repository and persona images no entry
references, and a built payload whose record count, version or context indexes
disagree with the index. Run it after an ingest and before a release, beside
`audit-indicators.js`; run `npm run build` first if the last check is wanted.

## Open items

Carried forward deliberately, not forgotten:

- **Eleven sources are held for a decision.** Each sits in `not_scraped[]` with
  `reason: "held-for-decision"`. Eight are the espionage advisories and reports
  described under "Indexing the espionage clusters" below; the other three are
  Chainalysis's IT-worker laundering write-up, a Cybersecurity News EtherHiding
  article and a Medium WageMole article, each carrying indicators the scraper
  cannot file safely.
- **The Raven File email list is declined.** The DPRK email list
  (`raw.githubusercontent.com/TheRavenFile/THREAT-ACTORS/...`) parses cleanly and
  holds 1,419 addresses, but its largest section pairs each address with a
  plaintext password, and the account holders may be victims of that leak rather
  than operators. It is recorded as `reason: "declined"` (checked 2026-08-30).
  The researcher's own write-up is a live source and carries the same addresses
  with the analysis around them, so the raw list adds only the passwords.
- **Account status goes stale.** These personas are spun up and taken down
  continuously — the first full sweep found 208 of 403 GitHub accounts and 40 of
  45 LinkedIn accounts already gone. Re-running the GitHub script periodically is
  cheap and safe. The LinkedIn one needs the manual browser session described
  above.
- **`username` has no extractor yet.** It is in the vocabulary, is searchable,
  and is accepted by the ingest, so an extractor can be added later without a
  data migration. `phone_number` has one; see "Wallets, and the other gated
  types".
- **Mirrored avatars are the repository's largest asset class** (~3MB across 195
  GitHub avatars at 200px, plus 5 LinkedIn photos at 128px). Fine at this scale;
  worth revisiting if the indexed account count grows by an order of magnitude.
- **ThreatFox needs an auth key, and is probably worth getting one for.**
  abuse.ch's ThreatFox is a community IOC database that tags every entry with the
  malware family it belongs to, and it carries the families this corpus already
  indexes under — BeaverTail, InvisibleFerret, OtterCookie. Its API answered
  anonymously until some point before 18 September 2026 and now returns
  `{"error": "Unauthorized"}` to every query, including the documented public
  ones:

      curl -X POST https://threatfox-api.abuse.ch/api/v1/ \
        -H "Content-Type: application/json" \
        -d '{"query":"malwareinfo","malware":"BeaverTail","limit":100}'

  A key is free with an abuse.ch account and goes in the `Auth-Key` header. That
  is the blocker: nobody has made one, and the key would be the repository's
  first scraper credential, so it belongs in `.env` beside `GITHUB_TOKEN` and in
  `.env.example` — never in `scrape-sources.json`, which is public.

  Two things to settle before ingesting any of it, because this is a different
  kind of source from everything registered here. It is **community-submitted
  rather than vendor-published**, so a value carries a reporter handle and a
  confidence percentage instead of a report making an argument; the site's model
  is that confidence comes from the source's own characterisation, and it is not
  obvious what that means for a crowd-sourced number. And its entries are mostly
  C2 addresses and hashes rather than the identity-shaped indicators this index
  is built around, so the yield may look like the JPCERT pass — large, real, and
  entirely infrastructure. Both are arguments about how to cite it, not reasons
  to skip it.

## Platform account types

Beyond `email_address`, `linkedin_profile` and `github_profile`, the scraper
extracts the rest of a persona's account spread from one table,
`PLATFORM_ACCOUNTS` in `scripts/lib/ioc-normalize.js`: `telegram_account`,
`gitlab_account`, `medium_account`, `devto_account`, `freelancer_account`,
`codesandbox_account`, `dockerhub_account`, `keybase_account`,
`huggingface_account`, `trello_account`, `quora_account`,
`odnoklassniki_account`, `freelancermap_account`, `fiverr_account`, and the freelance and profile hosts added on 24 September 2026, `upwork_account`, `laborx_account`, `peerlist_account`, `xing_account`, `torre_account`, `himalayas_account`, `producthunt_account`, `f6s_account`, `entre_account`, `linktree_account` and `calendly_account` — all
auto-extracted. Each is a handle under a fixed path on a fixed host, so one
spec per platform describes both the pattern and the normalizer. All take the
same victim-context guard as the LinkedIn and GitHub extractors. The same
table also carries `x_account`, held out of automatic extraction
(`auto_extract: false`) for the reason in the section below. So are the four added on 28 September 2026 for contacts read off persona portfolio sites, `instagram_account`, `facebook_account` (a vanity path or `profile.php?id=`), `stackoverflow_account` (keyed on the numeric user id) and `discord_account`: a report links its own publisher on Instagram and Facebook far more often than it names an operator there.

Several of these hosts sit on `HOST_DENYLIST` so that a stray social link in a
report never becomes an indicator. The extractor passes `platform`, which tells
`isExcludedUrl` this match is the account itself rather than a share button.

Add a platform only when you have seen it carry a persona account somewhere in
the corpus. An extractor for a platform no operator uses produces nothing but
false positives from report boilerplate.

`gitlab_account` was added on 2026-09-12 on exactly that basis. Searching the
open web for the handles this index already holds turns up GitLab accounts under
the same login more often than anything else, and a GitLab profile states two
things the matching GitHub account does not: a display name and a member-since
date. Six were found in one afternoon, and four gave a name nobody had recorded
— `evgpan` is "Евгений Панов", `climaxstar` is "Zenith Taylor", `gsofter` is
"Adelin Ionut", `guru2921` is "Guru Softwaremaster" — while `bejaxer` and
`hunter0409` state names the reporting had already attributed to those operators,
which is corroboration rather than a new lead.

### Why x_account is not auto-extracted

`x_account` is in the table with `auto_extract: false`, so the scraper skips it.
Measured against the 27 staged source texts the pattern produced 97 handles, of
which roughly a quarter were the reporting side rather than the reported: the
researchers who wrote the articles, news accounts, and the legitimate projects
that were targeted. A threat report names X handles on both sides of its own
story, and nothing in the surrounding prose distinguishes them — the victim
guard does not help, because a researcher's own handle sits in neutral text.

Publishing those automatically would put uninvolved researchers into an index of
DPRK indicators. The type remains available to curated files such as
`src/_data/iocs/x-dossiers.json`, where a person attributed each handle
individually. Do not flip the flag without a guard that solves the problem
above.

## Indicator blocks, and the two gates that could not read them

Every positive gate in this tool reads a window of characters either side of a
match, which assumes a report names an indicator's type next to the value.
Prose does that, and so does a two-column table. An appendix does not, and the
appendix is where the indicators are.

Two shapes matter, and each broke a different gate.

**A heading-style block** prints the label once and then lists values one to a
line. Genians' APT37 report ends with `MD5` above eleven digests, then `C2`
above six domains and five addresses. `looksLikeHashContext` reached the first
three digests and ran out, so the source was ingested holding 3 of its 11
hashes, and `looksLikeMaliciousContext` failed a little further down for the
same reason: a column of bare digests has nothing in the window but more
digests. `indicatorSectionLabel` in `scripts/lib/ioc-normalize.js` reads these
by walking backwards a line at a time from the match, stepping over blank lines
and over lines holding nothing but another indicator value, and stopping at the
first line of prose. Only a heading reached without crossing prose counts.

That stopping rule is the whole safety argument. kmsec's npm feed lists a hash
per release with `www.apple.com`, `www.w3.org` and `github.com` beside it, each
alone on its line, which is the shape the walk otherwise accepts. Every release
there is introduced by a maintainer line, which is prose, so the walk stops
before it reaches a heading and those benign domains are left alone.

**A table-style appendix** gives every row its own label instead. GitLab's
September writeup reads `IOC | Type | Description`, so each digest is followed
by the word SHA256 and then a sentence about the sample -- which means the hash
gate passes and the walk above correctly refuses to fire, since a row of prose
is where a block ends. All eleven digests carry their label; only three sat
close enough to malicious wording, so that source was ingested holding one
hash. `indicatorAppendixStart` answers the malicious question once for the
whole section, on the grounds that a heading reading "Appendix - Indicators of
Compromise" is the author saying so. It requires a real heading in the last
half of the document: ReversingLabs opens an article with the sentence
"Indicators of compromise play a crucial role in cybersecurity investigations",
and reading that as the start of an appendix would hand the rest of the piece a
gate it has not earned.

Neither shape relaxes the victim guard. `looksLikeVictimContext` is asked per
value and asked first, because a report names the files its subject forged
inside an appendix as readily as outside it. It costs two of GitLab's eleven,
which is the guard working.

Measured against the code before this change, over every staged run that still
carries its source text: `file_hash` goes from 27 to 48, `domain` from 0 to 27,
`hosted_site` from 46 to 49, every other type is unchanged to the value, and
nothing that was extracted before is lost.

### domain, and the judgment the gate cannot make

`domain` was a curated-files-only type until this change, and the reason still
stands for the general case: a domain-shaped pattern matches 12,695 times
across the staged corpus, led by `gmail.com` at 5,210, then `github.com`,
`outlook.com`, `cloudflare.com`, `akamai.net` and `fastly.net`. What makes the
type extractable is the block gate above -- a value standing alone on its line
under a heading that says `C2`.

The heading set is deliberately narrower than the set of headings that carry
domains. `C2`, `Command & Control` and `Malicious domains` assert the operator
controlled the value. `Domains`, `URLs`, `Hosts` and `Network indicators`
assert only that the traffic was seen, and such a list mixes in whatever
legitimate service the malware happened to contact: under a bare `Domains`
heading Unit 42 carries `mirotalk.io` and `freeconference.io`, real products a
lure pointed victims at, beside the operator's own `regioncheck.net`.

Defanging would have been the obvious gate, since writing `evil[.]com` is an
act of attribution by the author. It is not usable here. Across all 116 staged
runs the corpus contains zero defanged domains, so a gate built on it would
extract nothing.

Three exclusion lists sit under the gate, each for a class no heading can rule
out. Mail providers, because this type means a domain an operator registered
and a consumer mail provider is the opposite of that. Public infrastructure,
because ReversingLabs lists `polygon-rpc.com` and `rpc-amoy.polygon.technology`
under "C2 domains and IP addresses" -- the loader reads its real endpoint off
the chain through them, which makes them infrastructure the operator used and
not infrastructure the operator controls, and republishing them would tell a
defender to block the public Polygon RPC. And blockchain-name suffixes, because
`.eth` is not DNS and has its own type; DOJ's forfeiture complaint listed
`vhurryharry.eth` and `halfmooneye.eth` in a C2 block and they would otherwise
have been published twice under two types. Hosting-platform subdomains are
excluded for the same double-typing reason, which is what added `fly.dev` and
`cafe24.com` to `HOSTED_SITE_HOSTS`.

**What the gate cannot decide, and who decides it.** A `C2` heading says the
malware talked to the value. It does not say the operator registered it, and
this type asserts that it did. Those come apart constantly, because planting a
webshell on somebody else's site is ordinary tradecraft for these actors.
Genians lists `ycpatent.co.kr`, `printory.kr` and `fe01.co.kr` under `C2`, and
its own prose describes the webshell as having been registered *at* those
sites: they are compromised businesses, a patent firm among them, not operator
infrastructure. ReversingLabs' list is the opposite -- `clob-polymarket.com` and
`winstonjs.site` are typosquats nobody registered by accident.

Nothing in the text separates the two, so the extractor does not try. It stages
candidates; establishing control is a review step. **When a pull request from
this workflow adds `domain` records, check each one for this before merging**,
and drop the ones that turn out to be somebody's compromised website. Naming a
patent firm as DPRK infrastructure is the failure the rest of this tool is
arranged to avoid.

## Wallets, and the other gated types

`wallet_address` (Ethereum, Bitcoin, Solana), `hosted_site` (a subdomain on a
free hosting platform) and `skype_account` are extracted with different guards
from everything else, because their false-positive modes differ.

**Wallets carry both gates and always will.** A report prints the victim's
address in the same paragraph as the operator's, and the two are identical in
shape — nothing about `0x…` says which side of the story it is on. Measured over
the 27 staged source texts, the raw Ethereum pattern matches 385 addresses and
the gates cut that to 30. That 92% rejection is the guard working. Do not relax
it to raise the count.

Solana is narrowed to 43–44 base58 characters with a first character that is not
`1` or `3`. Base58 is shared with Bitcoin, and a looser pattern silently
reported Bitcoin addresses as Solana keys.

**`hosted_site` is the safe subset of "extract domains".** A general domain
extractor fires on every vendor, CDN and news site a report mentions. Limiting
it to platforms that hand anyone a subdomain — `vercel.app`, `netlify.app`,
`onrender.com`, `pages.dev`, `fly.dev`, `cafe24.com`, `up.railway.app` — captures what an
operation actually stood up. Both gates apply, since reports also name the
legitimate sites being impersonated. The last two were added when the block
gate above read them out of C2 lists: `nvidiasdk.fly.dev` and
`oxenhan1.cafe24.com` are attacker-chosen subdomains, so they belong to this
type rather than to `domain`.

**`payload_url` is the opposite case from `hosted_site`.** On a paste or JSON-bin
service the host belongs to everybody and only the path is the operator's, so
the host alone is not an indicator and the stored value is the whole URL, for
example `https://jsonkeeper.com/b/4NAKK`. `PAYLOAD_URL_HOSTS` in
`scripts/lib/ioc-normalize.js` names the services (JSON Keeper, npoint, Mocki,
JSONsilo, JSONBin, Pastebin), each with the report that justifies it, and the
bare host of any of them is refused by `isExcludedDomain` so it is never also
published as a `domain`. A URL on one of them is taken in a malicious,
non-victim context. A URL on any other host is taken only from a row of an
indicator table whose type column says `url` or `malware` and whose row calls
itself hostile (`isHostileTableRow`), which is how GitLab's year-in-review
contributes the `chainlink-api-v3.cloud/api/service/token/<hex>` addresses. A
free-hosting subdomain in such a row stays a `hosted_site`, and an address
stays an `ip_address`. Such a URL serves live malware, so it is shown as text
wherever it appears and `scripts/check-site.js` fails the build if one is inside
an `href`. The host of a row URL outside the list is not made a `domain`: a row
says what the malware fetched, not who registered it, and that call stays with
the reviewer.

**`skype_account` needs no positive gate.** Nothing else in a report is shaped
like `live:.cid.<hex>`, so there is no false-positive surface; only the victim
guard runs, as for GitHub and LinkedIn.

**`phone_number` is taken only where something labels it.** A digit run is the
commonest thing in a report, so the extractor accepts one only when a phone word
(phone, telephone, tel, mobile, cell, WhatsApp, Signal, contact number) sits on
its own table row of 240 characters or fewer, within 40 characters before it in
the same sentence, or the current heading is about phone numbers. The shared
section and victim guards still apply. A publisher's address block or a WHOIS
record (Fax, Suite, Registrant, nic-hdl, a court's signature block) is refused,
since the vendor's switchboard repeats in every page footer and a registrar's
number is not the operator's. `normalizePhone` then decides identity: a number
printed without a plus is accepted only when its shape names its own country
(86 and a 1 for a Chinese mobile, an 89 trunk prefix for a Russian one, a NANP
number whose area code and exchange start 2 to 9), and ISO dates and dotted-quad
addresses are refused outright. Over the 1,359 staged texts this finds
about a dozen numbers beyond the GitLab report, all in prose or labelled lists. Ingest
grounds a phone number on its last nine digits against the page's digits, since
the page never printed the E.164 form.

**An `npm_package` row of an indicator table counts as context.** A bare name in
prose never qualifies, but a line that opens with a package name followed by the
words "npm package" is a table row whose type column states what it is, and the
extractor takes it when the rest of the row calls the package hostile
(malicious, malware, dropper, insider and similar). GitLab's year-in-review
lists seven packages this way and the registry-URL pattern found none of them.

### Why alias is not auto-extracted

Every other curated-only type is kept out of the extractors because its
pattern misfires. This one has no pattern at all, and could not have a usable
one: a personal name has no shape a regular expression can recognise, and the
names printed in a threat report belong overwhelmingly to researchers,
victims, journalists, prosecutors and vendor staff rather than to operators.
An extractor would produce a list of the people who wrote the report.

What makes the type safe is exactly what makes it unautomatable. A person read
a source that named an operator outright and transcribed the name with its
citation, which is what the dossier files are and what the `researcher-post`
and `third-party-registry` labels tell a reader. Nothing in
`scrape-dprk-iocs.js` should ever produce an `alias` record.

### Why ens_name is not auto-extracted

Same reason as `x_account`. Gated over the staged corpus the pattern kept three
`.eth` names and all three belonged to researchers and traders rather than
operators. A `.eth` name in a crypto-crime report is as likely to be the person
reporting as the person reported on. The type stays available to curated files.

## IP addresses and ASNs

`ip_address` has needed no code beyond a plain exclusion list since the
pattern and `normalizeIpv4` were first written: `isReservedIpv4` in
`scripts/lib/ioc-normalize.js` already drops private, loopback, reserved and
documentation ranges, exactly as this document's extraction-steps section has
described all along. What was missing was an `EXTRACTORS` entry actually
wiring the pattern in — the normalizer existed and was tested, but nothing in
`scrape-dprk-iocs.js` ever called it, so no `ip_address` record had ever been
produced. Fixed by adding the entry with no additional guard: a malicious-
context gate was tried against the staged corpus and made things worse. Unlike
a wallet address, the IPs in this corpus are not printed next to a victim's IP
in the same shape — they are the report's own findings about operator
infrastructure (VPN egress points, C2 hosts, the IP behind a compromised
account's login) — so requiring nearby "malicious" language cost recall
(including a genuine operator IP inside a sentence with no such language)
without rejecting anything that needed rejecting.

That plain exclusion list turned out not to be enough, and the three rules
added to `normalizeIpv4` on 2026-09-12 are what the published index needed
rather than what the next run needs. 154 of the 2,674 addresses it held were not
addresses at all, or were addresses belonging to someone whose business is
serving other people's sites:

- **Version numbers, OIDs, numbered sections and hex dumps.** 34 records, from
  `1.3.6.1` (an X.509 OID prefix) through a column of EDRKillShifter build
  numbers to the section numbering of a Korean monthly threat report. An earlier
  audit had removed nine of these by hand and noted that the pattern belongs in
  the extractor; `isVersionShapedIpv4` is that rule. It rejects on shape alone —
  a leading octet of 9 or less with every other octet under 32 — because the
  context cannot decide it: that report's section numbers sit in a paragraph
  about IPv4 addresses, and the build numbers sit in a table of malware
  infrastructure. No genuine address in this corpus has that shape; the real
  low-first-octet ones are Korean (1.223.129.234) or AWS (3.137.98.129) and
  every one carries an octet well above 31.
- **Public DNS resolvers.** 1.1.1.1 and 8.8.8.8, both arriving from a report
  pasting its own terminal session — an `nslookup` checking whether a C2 domain
  still resolved, and a ping to Google's resolver to test connectivity.
  `PUBLIC_RESOLVER_IPS` covers the rest of them for when they do the same.
- **CDN edge ranges.** 118 records inside Cloudflare's, Akamai's or Fastly's
  published ranges, which is what resolving a lure domain returns. The address
  identifies the proxy in front of the site, not the machine behind it; blocking
  one blocks a sizeable slice of the web. Cloud compute is deliberately not on
  that list, because an operator renting an AWS or Linode box chose it.

A leading zero in an octet is also rejected now: `03.149.98.247` was read off a
line-wrapped table and is not a dotted quad.

`normalizeIpv4` is a pure function of the value, so `ingest-scraped-iocs.js`
re-applies it to every stored address on each run, the way it already re-applied
the email rules. That is what reaches a value which shipped before the rule
existed — without it, 1.1.1.1 would have stayed in the index and the rule would
only have gated future harvests.

`asn` is a new type, added because reports in this corpus name Autonomous
System numbers as knowingly as they name IP addresses — TransTeleCom
(AS20485), North Korea's own AS9341 and AS131279, and the VPN/hosting
providers a sanctions filing lists as carrying IT-worker traffic. Unlike an IP
address, an ASN is unremarkable infrastructure metadata until a report says
whose it is, so it takes the same positive malicious-context, not-victim gate
as a wallet or npm package. Measured over the staged corpus: 19 raw matches,
15 survive the gate. `normalizeAsn` also excludes two numbers that share the
`AS####` shape but mean something else in ordinary technical writing — the IBM
AS/400 platform and the AS9100 aerospace quality standard — on the same
"exclude on sight, even with no example yet" logic the email and URL denylists
already use.

`wallet_address` gained a fourth chain, Tron, alongside Ethereum, Bitcoin and
Solana in `WALLET_PATTERNS`. A Tron address starts with a literal `T` followed
by 33 base58 characters, which cannot collide with Bitcoin's `1`/`3`/`bc1`
prefixes, so it needed no disambiguation beyond what Solana already required.
It takes the identical two-gate treatment described below. Measured over the
staged corpus: 27 raw matches, one survives — a Tron address a sanctions
filing ties to three separate DeFi hacks. The same low survival rate this
document already treats as the guard working, not a bug.

Deliberately not added, on the same corpus:

- **IPv6.** The naive shape check produced zero genuine addresses — every
  match was an `HH:MM:SS` timestamp from a screen recording or log excerpt.
  There is no positive evidence yet to justify the pattern.
- **CIDR ranges.** Ten raw matches, all of them the same two already-published
  DPRK-associated netblocks (`175.45.176.0/24` and neighbours; TransTeleCom's
  `188.43.0.0/24`s) appearing in more than one source. Low volume, and storing
  a `/24` as though it were a single `ip_address` would misrepresent a network
  as a host. Left for a human to decide whether a dedicated range type is worth
  adding.
- **CVE identifiers.** All ten raw matches came from one page's "Related
  Posts" sidebar, linking to an unrelated Keycloak advisory and an unrelated
  VMware advisory — zero of ten had anything to do with DPRK activity.
- **File hashes (MD5/SHA1/SHA256).** High volume (17/315/121 raw) but not
  safely separable from boilerplate with a bare regex. One MD5-shaped match
  was a malware sample's runtime client ID embedded verbatim in quoted source
  code, not a hash. 305 of the 315 SHA1 matches, and 92 of the 121 SHA256
  matches, come from two single reports' package-version tables (a
  `package_name / version / hash` row per npm release) — a shape a
  distance-based "malicious nearby" gate cannot resolve sensibly: tightening it
  drops nearly everything, loosening it means one report's table dominates the
  whole index. Extracting hashes safely here needs a table- or label-aware
  extractor this scraper does not have, not a new regex. See
  `docs/scrape-dprk-iocs.md`'s open items above — this is now the reason a
  future `file_hash` extractor is worth designing deliberately rather than
  bolted on the same way as the types above.
- **Bare npm package names** (`npm install <name>`). Reproduced the exact
  failure the code comment on `NPM_PACKAGE_PATTERN` already warns about: one
  match was the English sentence "treat every npm install as code execution",
  yielding a package literally named `as`. The rest were legitimate,
  widely-used packages (`axios`, `sharp`, `socket.io-client`) that a malicious
  package depends on or imitates, not malicious packages themselves.
- **Mutexes and filenames.** No safe, narrow pattern with real volume was
  found. A "mutex" heuristic keyed on nearby quotation marks matched nothing in
  this corpus, and a filename is too broad a shape (`word.ext`) to extract
  without a positive gate this pass did not have time to design and validate.

## Indexing the espionage clusters

**Decided 2026-09-09; the index side is implemented.** `src/_data/iocIndex.js`
gives a record the `espionage` area when every campaign label it carries is one
of Lazarus Group, Kimsuky, APT37, Konni, APT38, Andariel, Moonstone Sleet or
"DPRK (cluster unattributed)". Such records leave the `/remote-workers/` counts,
chips, download and default search, but stay in the shared search index
(`totals.espionage`, `espionage.records`), and `src/_data/clusters.js` counts
and scopes each cluster page's search over the remote-worker and espionage
records together. A record that also carries an IT-worker label stays in
`remote-workers`. What has not happened is ingesting the sources below: eight
verified sources still wait in `not_scraped[]` under `held-for-decision` -- the
NIS joint advisory, two joint advisories published by Germany's BfV, AhnLab on
PebbleDash, three Genians reports and Beosin's theft attributions -- each with a
note saying what it actually holds.

The five points below were the plan for that work, in order; points 1 to 3 are
in place, and the ingest itself remains gated on points 4 and 5:

1. **A campaign label per cluster.** Every label in use today names
   revenue-generating activity (`IT Worker Fraud`, `Contagious Interview`,
   `PolinRider`, `NullReceiver`, `EtherHiding`), and the label is what a
   cluster page's search filters on. Espionage needs its own: `Kimsuky`,
   `Lazarus Group`, `APT37`, `Andariel`, named as the taxonomy already names
   them in `src/_data/taxonomy.json`.
2. **`ioc_scope` on the five narrative cluster pages.** Only
   `/clusters/contagious-interview/` and `/clusters/polinrider/` carry an
   indicator search; the other five render as prose. Wiring their scope to the
   new labels is what turns those pages into the natural home for this
   material.
3. **A decision on `area`.** `src/_data/iocIndex.js` assigns every record one
   of `remote-workers`, `etherhiding`, `polinrider` or `espionage`, and that is
   what decides which search finds it. The decision taken was a fourth area,
   `espionage`, rather than widening `remote-workers`. The paragraphs below
   record the framing correction made while the question was open.

   **The framing half is done, and it was long past due rather than newly
   urgent.** The copy read "This index covers identity indicators only", which
   this document expected to stop being true once espionage was indexed. It had
   stopped being true well before that, and by a wider margin than the hash work
   alone: `remote-workers` is the catch-all area with no type-based exclusion,
   so the built index carries 352 `ip_address`, 57 `hosted_site`, 45
   `file_hash`, 40 `domain`, 13 `filename` and 5 `asn` records -- about 510 of
   6,129, against roughly 5,600 identity records. The hash work added to a
   category that already existed rather than opening it. Since `counts_by_type`
   gives every type present its own filter chip, the page was asserting
   identity-only while rendering chips for six types that are not identities.
   It now says it is the global index and names infrastructure and malware
   artifacts as what sits alongside the identities. Corrected 9 September 2026.

   What remains is the naming question alone: whether an area called
   `remote-workers` should go on being the destination for everything that is
   not EtherHiding, PolinRider or espionage. That is a rename, and it is worth
   doing deliberately, because the area string appears in the download
   filenames and in the JSON the search fetches.
4. **Re-check the victim gates against espionage reporting.** These reports are
   shaped differently from supply-chain writeups: they name targeted
   organisations, embassies and government bodies throughout, and
   `looksLikeVictimContext` was tuned on package and account language. Run each
   source and read the output before ingesting, the way the sources added on
   2026-09-09 were handled.

5. **Build a domain extractor, or accept that the domains will be dropped.**
   **Done, on 10 September 2026, and the shape of the answer changed what this
   entry expected.** It corrected an earlier claim that the four IOC types
   these advisories lean on -- file hashes, C2 domains, IPs and YARA rules --
   were already extracted except the last. Two of the four were. YARA rules
   still have no indicator type here and should stay in the prose.

   Domains are now extracted, gated on membership of a block headed `C2`
   rather than on a pattern. Building it turned up something this entry did not
   anticipate: the same defect was already costing hashes on sources the site
   had ingested and recorded as read. Both positive gates read a fixed window
   and neither can see an appendix, so Genians was holding 3 of its 11 hashes
   and GitLab 1 of its 11. `file_hash` went from 27 to 48 across the staged
   corpus, `domain` from 0 to 27, and nothing was lost. The section above,
   "Indicator blocks, and the two gates that could not read them", is the full
   account.

   Two things the extractor does not settle, both of which bear directly on
   ingesting these advisories. It cannot tell an operator-registered
   domain from a compromised third-party site listed under the same heading,
   and Genians is the case in point -- `ycpatent.co.kr` is a patent firm whose
   site had a webshell planted on it, and this type asserts operator control.
   That is a review step, not a gate. And these advisories are mostly PDFs,
   which reach extraction through `parsePdf`; whether a PDF indicator table
   flattens into the line-per-value shape the block walk needs has not been
   checked against any of them yet, and should be before the ingest is planned
   around it.