# Persona dossiers from X

`src/_data/iocs/x-dossiers.json` holds persona dossiers transcribed by hand from
public posts by researchers on X — [@browsercookies](https://x.com/browsercookies),
[@zachxbt](https://x.com/zachxbt), [@Narcass3](https://x.com/Narcass3),
[@tanuki42_](https://x.com/tanuki42_), [@unpacker](https://x.com/unpacker),
[@meow_mfer](https://x.com/meow_mfer), [@heihei5711](https://x.com/heihei5711),
[@blackbigswan](https://x.com/blackbigswan) and
[@eastside_nci](https://x.com/eastside_nci) at the time of writing, each named
in the file's `researchers` map and cited on every record they account for.
Recount from the file rather than trusting that list; it has gone stale before. It is the
only indicator file in this repo that is not either scraper output or a
maintainer's own ruleset, and it exists because the scraper cannot reach the
source.

One entry is not an X post at all. The `knowbe4` key carries the identity
KnowBe4 hired in July 2024, transcribed from the company's own incident report
and whitepaper. A vendor's first-hand account of an identity it hired is the
same kind of claim as a researcher's post -- one named publisher, one date, one
identity -- and is admitted on the same terms.

## Why this is not a scraper source

`scrape-sources.json` lists `https://x.com/browsercookies` under `not_scraped[]`
with `reason: "client-side-rendered"`. That decision stands. Three walls, any
one of which is enough:

**Authentication.** x.com serves a JavaScript shell to an anonymous request and
renders through an API that requires a signed-in session. `scrape-dprk-iocs.js`
does a plain `fetch` with a content-type allowlist and runs in GitHub Actions,
which has no session. This is the same wall that keeps
`enrich-linkedin-accounts.js` a manual, non-CI script.

**Format.** The posts write indicators in forms the shared extractors reject on
purpose — defanged (`name@gmail[.]com`), domainless (`gmail = marksantiago0929`),
and as bare handles (`Git: Bazzar2000`). Loosening the regexes in
`ioc-normalize.js` to catch these would raise the false-positive rate across all
29 scraped sources. A person transcribes instead.

**Images.** Most posts carry screenshots, and much of the material — resumes, ID
cards, profile captures, whole indicator tables — is only in the pixels. No
automated path reaches any of it, and none is planned: OCR output that nobody
reads is a way to publish confident-looking nonsense about named people.

Values may nonetheless be transcribed from an image BY HAND, and some now are.
ZachXBT's August 2025 post on five operators running thirty-one identities is a
single screenshot of a table — the addresses and accounts in it exist in no
machine-readable form anywhere. Leaving them out was not neutrality, it was
discarding the highest-fidelity material in the corpus.

Where that is done, three things are required. Read the image at full
resolution, in sections, rather than transcribing from a thumbnail. Say so in
the entry's `note`, which becomes the context line shown on every indicator
page, so a reader knows the provenance is a person reading a picture. And
transcribe exactly what is shown, including what looks like a mistake:
`johnathon.h.tneg18@gmail.com` transposes the surname in a way the identity's
own LinkedIn slug does not, and "correcting" it would invent an address.

A dossier may also carry a photograph of the person who appeared under the
identity, through the optional `photo` field described below. That is not an
extracted value — it is evidence the post published, shown with its citation.

## What the file asserts

A dossier is a named researcher's claim that a set of accounts belongs to one
operator, and in most entries that the operator's real name is a specific Korean
name. That is a stronger claim than any other source in this corpus makes, and
it ships without a methodology section a reader can check. It is published here
as the researcher's assertion, attributed to them, and never restated as this
site's own finding.

Records from this file therefore carry their own provenance label,
`researcher-post`, rendered as **RESEARCHER POST** — deliberately between
`regex` (a machine matched the value literally in a published report) and
`bulk-dataset`. `.eleventy.js` and `ioc-search.js` both hold that mapping; change
them together.

Where the scraper independently matches the same value in a published report,
the record is promoted to `regex` and shows **MATCHED IN SOURCE** instead. That
is intended: a value found verbatim in a vendor report is better evidenced than
the same value in a post. The record keeps both citations and the persona page
still credits the researcher, so the attribution is visible — only the headline
label changes.

## Transcription rules

- **Re-fang, never rewrite.** `name@gmail[.]com` becomes `name@gmail.com`;
  `gmail = marksantiago0929` becomes `marksantiago0929@gmail.com` because the
  post's own label supplies the domain. Nothing else about a value is altered.
- **Never add an indicator the post does not state.** No inferring a GitHub URL
  from an email local-part, no completing a partial handle.
- **Respect the source's own attribution boundary.** Indicators the post files
  under "Unattrib", or lists without naming an operator, go in
  `unattributed[]` and anchor no persona. Attaching one would be an attribution
  the researcher declined to make.
- **Record what could not be carried.** Anything with no indicator type in this
  repo goes in an entry's `unextracted[]`, so the gap is visible rather than
  silently dropped. Slack workspace names are one such case; Telegram,
  Trello, dev.to, Quora, Medium, Odnoklassniki and X all have types now (see
  `PLATFORM_ACCOUNTS` in `scripts/lib/ioc-normalize.js`). A domain an operator
  controls outright now has the `domain` type, added because four entries were
  holding one back; it is curated-only and never auto-extracted, for the reason
  written above `normalizeDomain`. What still has no type: a profile URL on a
  platform the repository does not model, such as a LinkedIn company page -- the domain in those belongs to the
  platform rather than the operator, so recording it as a `domain` would be
  wrong; a Telegram numeric peer ID, which is not a username; a bank account; and
  a handle a post names without saying which platform it is on, which cannot be
  typed without guessing.
- **An unattributed group may name itself.** A group in `unattributed[]` can
  set an optional `label`, which becomes the section shown on each of its
  indicator pages in place of the generic "Unattributed". Use it to say what
  the set actually is and tie it to the post it came from. It changes the
  label only: the group still anchors no persona, which is the whole point of
  the list.
- **One `posts[]` entry per citation.** An indicator may name its post by index;
  a persona documented across two posts keeps both, and both are cited.
- **A post's date is its UTC date, derived from the identifier.** X displays a
  post in the reader's own timezone, so transcribing the date as shown makes the
  citation depend on who was looking. Fifteen entries were recorded that way and
  have been corrected. Compute it instead, from the snowflake:
  `new Date(Number((BigInt(id) >> 22n) + 1288834974657n))`. Only posts published
  within a few hours of UTC midnight differ, which is exactly why the
  inconsistency went unnoticed for so long.
- **A name a source states is an indicator, where it states nothing else.**
  `alias` carries the name an operator presents under. It exists because the
  most common shape in this corpus is a researcher who interviewed somebody,
  concluded they were a DPRK IT worker, and published exactly two things: the
  name and a photograph. A dossier builds records from indicators, so before
  this type a persona with neither an account nor an address produced no page
  at all, and around thirty such claims sat on the held-back list under a
  reason that read as restraint when the real reason was that there was no
  field for them. The site was publishing a name whenever it happened to
  arrive with a GitHub account and hiding the same researcher's identical
  claim when it did not, which is backwards: a hiring team searches a name
  long before it searches a handle.

  Use it only for a name a source attributes to an operator outright, and
  record the persona's own name and each alias as their own `alias` record so
  every one of them is searchable. It is never auto-extracted, for the reason
  in `docs/scrape-dprk-iocs.md`.

  A single given name is accepted. It was rejected at first on the argument
  that "Rami" is not something a defender can search for, which was the wrong
  test. Nobody concludes anything from a first name alone and the entry should
  not pretend otherwise, but an operator who introduced himself as Rami on one
  call will do it again on the next, and the reader who has just been handed
  that name is exactly who the index is for. A weak indicator is not a false
  one, and the page it lands on names the researcher who asserted it and shows
  the photograph that came with it. Say in the `note` that a given name settles
  nothing, and let the reader weigh it.

  Where the source is unsure of the name itself, record every form it offers
  and say so. A post reading "a Patrick/Michael Brown" over a call frame
  captioned Patrick New yields three `alias` records and a note that none of
  them is settled -- which is more use to a reader than publishing one and
  more honest than publishing none.

  Digits keep the boundary with a handle. `cryptolegend92` is an account name
  on some platform, and a handle whose platform a source does not state stays
  on the held-back list rather than being relabelled a person's name here.

  You do not write these records by hand. `derivedAliases` in
  `scripts/lib/dossiers.js` emits one for a persona's own name and for each
  entry in its `aliases[]`, so putting the name in the entry is all that is
  needed. Transcribe an `alias` indicator explicitly only in an
  `unattributed[]` group, which has no persona for the derivation to read.

- **A photograph is mirrored, cited and captioned for what it shows.** An entry
  may carry `photo: { file, post, caption }`. `file` is a path under
  `src/assets/img/personas/`, holding a copy saved into this repository — never
  a hotlink to the platform, which is the same rule the mirrored LinkedIn and
  GitHub avatars follow. `post` indexes `posts[]`, so the image is published
  with the citation it came from. The caption says what the picture actually
  depicts: the person who turned up under the identity is not necessarily the
  person whose details the identity was assembled from, and these personas
  routinely use images of uninvolved people. `scripts/lib/personas.js` drops a
  photo whose file is not in the repository, so a missing image is an absent
  block rather than a broken one on a published page.
  `face` says whether the picture may stand for the persona: `true` lets it
  lead the persona's page, `false` files it under "Profiles and evidence"
  as the record of what a page showed. **A photograph from a pipu.cc listing
  is always `face: false`.** A perceptual hash over every thumbnail in that
  set (21 September 2026) found 519 product images each attached to two or
  more listings under different names: the uploader dressed the CVs from a
  pool, and the image on a listing says nothing about the person on it. Those
  entries carry a `reused_on` count and a caption that says so, and
  `scripts/lib/personas.js` keeps any `-pipu` image out of the persona grid
  regardless. See the second pass in `_drafts/private/docs/pipu-lead-screening.md`.
- **Values are normalized on load, not by hand.** `scripts/lib/dossiers.js` runs
  each value through the same normalizer the scraper uses, so a handle
  transcribed here and the same handle matched in a report later collapse to one
  record. A value that fails to normalize throws at build time — that is a
  transcription error, not something to publish.

`x_account` deserves a note: the scraper deliberately does not extract it, because
in report prose a quarter of the X handles belong to researchers and victims
rather than operators (see `docs/scrape-dprk-iocs.md`). It is safe here only
because each handle in this file was attributed by a person reading the post that
named it.

## How it reaches the site

`scripts/lib/dossiers.js` converts each entry into records in the same shape
`scraped-iocs.json` holds, setting `sources[].section` to the persona label and
`persona_key` to the persona. `scripts/lib/personas.js` then groups them exactly
as it groups scraped records, so these personas get pages at
`/remote-workers/personas/<slug>/` with no special case, and
`src/_data/iocIndex.js` merges the same records into the searchable index.

Unlike a scraped persona, a dossier persona usually has no LinkedIn account —
the LinkedIn accounts section on its page is simply absent, and its indicators
render under "Identifiers attributed to this persona".

## Adding more

`_drafts/private/docs/x-source-backlog.md` records what has been transcribed from each
researcher, what is still outstanding, and how to enumerate an account without
missing half of it. Read it before starting a pass: keyword search and timeline
scrolling both silently omit posts, and the backlog explains what to do instead.

Edit the JSON by hand. There is no capture script: the value of this file is the
judgment applied while transcribing, and the volume is low enough that a script
would mostly automate the part that should not be automated. Run
`npx @11ty/eleventy` and check the persona pages before opening a PR.
