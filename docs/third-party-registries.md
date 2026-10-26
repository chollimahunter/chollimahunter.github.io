# Third-party indicator registries

`src/_data/iocs/third-party-registries.json` holds per-persona dossiers taken
from standing third-party databases, currently the DPRK IT-worker registry at
[lazarus.group/team](https://lazarus.group/team) — 72 personas and 457
indicators.

It uses the same schema as `x-dossiers.json` and is read by the same loader,
`scripts/lib/dossiers.js`. It is a separate file because the provenance is a
different kind of thing: an X post is one named researcher's claim, published
once, on a date. A registry is a database with no byline, no date per entry and
no methodology page. Records from here therefore carry their own label,
`registry`, rendered as **THIRD-PARTY REGISTRY** — the same rank as a researcher
post in `mergeRecords`, because both are somebody else's attributed claim about
one operator, and above a bulk list, because a named per-persona dossier says
more than an address on a flat list.

## Why this was a one-off extraction and not a scraper source

`scrape-sources.json` lists `https://www.lazarus.group/team` under
`not_scraped[]` as client-side-rendered, and that stands for the generic
scraper. The registry is a Next.js app: the data is in neither the HTML nor an
API, but compiled into a route bundle at
`_next/static/chunks/app/team/[slug]/page-<hash>.js`, as a JavaScript object
literal with unquoted keys and `new Date()` calls. The hash changes on every
deploy, so nothing could hardcode it.

Extracting it was a matter of finding the array in the bundle, scanning for its
balanced closing bracket while respecting string literals, and evaluating it in
a `vm` context whose only global is `Date`. That is cheap to do once. Doing it
on a schedule would mean re-discovering the chunk from the page's script tags on
every run and re-evaluating third-party JavaScript weekly in CI, which is a
standing trust commitment for a source that changes slowly. **To refresh it, run
the extraction again by hand** rather than automating it.

The chunk is not in the page's script tags — it is fetched on demand, so read
its URL from the browser's resource timings on a `/team/<slug>` page rather than
from the HTML. Then:

```
node scripts/extract-lazarus-registry.js <chunk.js> <raw.json>
REGISTRY_PULLED_AT=2026-09-09 node scripts/build-lazarus-registry.js <raw.json> src/_data/iocs/third-party-registries.json
```

`REGISTRY_PULLED_AT` stamps every record's `pulled_at` and defaults to the day
the script runs, which is right when the chunk is downloaded in the same
sitting and wrong when it is not. A registry entry carries no date of its own,
so when the values were read is the only date there is.

The build script writes the whole file, and the file has since been edited by
hand (the zeusdev919 working document and its entries, persona corrections,
notes), so do not replace it with the output. Build into a scratch path and
compare per registry page instead: the refresh on 28 September 2026 found one
new value, jwtradera@outlook.com under Kazune Takeda, and that was the only
change applied. The script's output also stores Gmail addresses dot-folded
where the file keeps the registry's spelling; that difference is harmless,
because every value is normalized on load.

## The wallet block, and a bug that hid it

The registry gives each persona a **Wallet Addresses** block, rendered under
that heading on the persona page and annotated per address where it knows what
the address did (`0xC43B1f4E7E47bE5D5663C3B26E4FB3fE7e217f90 (Metaplay Theft)`
on Jikun Liao's). In the bundle it is `onchain_activity`, a list of
`{ address: [...] }`.

The first mapping pass read wallets only from `salary_details`, so the whole
block was dropped: 52 addresses across 24 personas. It also silently cost four
personas -- James Zook, Joel Kursala, Wubone and Eric Manager have no email or
account in the registry at all, so an address was their only indicator and the
`if (!indicators.length) continue` guard discarded the persona along with it.
That is why the count above went from 68 personas to 72 without the registry
itself gaining an entry.

These are the operator's own attributed addresses rather than counterparties,
which is what separates them from the `websites` list below and puts them on the
indicator side of the same judgment.

## What was deliberately not taken

Two fields in the registry are not indicators and are excluded:

- **`websites`** — 98 URLs, and they are the registry's *evidence* list, not the
  operator's infrastructure. Alongside two or three persona portfolio domains it
  holds justice.gov press releases, Medium write-ups about the victim projects,
  cryptototem project pages and x.com status links. Publishing those would list
  the DOJ and a set of robbed crypto projects as DPRK indicators.
- **`associates`** — cross-references to other personas in the same registry.
  Copying them onto each entry would attribute one operator's accounts to
  another, and both operators are already in the file in their own right.

A GitHub entry contributes only its `gh_id`. The sibling `usernames` are that
account's rename history, and GitHub releases an abandoned name for anyone to
claim, so publishing each as its own profile would invent accounts.

The registry's own fields are not clean — LinkedIn and GitHub URLs appear inside
`personal_emails`. Every value is therefore re-classified by its shape rather
than trusted to the field it was filed under, then put through the same
normalizers the scraper uses. Two values survived neither and were dropped
rather than repaired: a phone number written `N/A`, and a malformed LinkedIn URL
missing its `/in/` segment. Four ENS names filed among the wallet addresses were
kept as `ens_name`, which this repo has a type for.

## What it is worth

Of 405 indicators, 204 kept the registry label and roughly half merged into
records this site already held from published reports — which is corroboration,
not duplication, and it is visible on the page: 14 personas are now attested by
more than one independent source.

## Photographs

Every image the registry publishes, not only the first, goes on the persona page
once it has been looked at. Until 28 September 2026 the build took only the
first `face`-tagged image per persona, so Kazune Takeda showed one of four
photographs and 41 approved images across the registry were missing.

The decision for each image is recorded by hand in
`scripts/data/lazarus-registry-images.json`, keyed by the registry's own image
path: `use`, `face` (false for a profile screenshot kept as evidence), the
mirrored `file`, and a reason when it is held. `scripts/build-lazarus-registry.js`
attaches every used image through `scripts/lib/lazarus-registry-images.js`; the
first face is the card portrait. An image with no recorded decision is not used,
so a refresh that finds new images leaves them off until they have been seen.
`scripts/fetch-lazarus-registry-photos.js` downloads only those undecided
images, documents included, into `_drafts/registry-photos/` (or a
directory passed as its second argument), named
`lazarus-group-<registry id>--<file name>`. Resize the ones used to at most
1000px on the longest side and move them into `src/assets/img/personas/`.

On 28 September 2026 the maintainer decided to carry everything the registry
publishes: all 131 images, identity documents, crowds and avatars included, and
its files[] attachments (four CVs as PDF, mirrored under
`/assets/files/lazarus-group/` and listed on the persona page under "Files
published with this identity"). Each image records a `kind` (photo, wanted,
screenshot, group, document, resume, avatar) that sets its caption; everything
but a portrait or a wanted-poster photograph is `face: false`, so it sits under
"Profiles and evidence" and never becomes the card portrait. A document
caption says the name, number and photograph are the document's own and may
belong to a real person whose identity was stolen. Three registry images and
two files (a video clip and one resume) answer 404 and are not carried.

The review still matters for new images: it decides the `kind`, and an image
with no entry stays off the page. What the first review sorted out:

- Flat graphics and avatars — placeholder glyphs, a GitHub Octocat, pixel art,
  stock clip art, cartoon and anime illustrations.
- Stock renders of objects: two Bitcoin coins, an Ethereum coin, a Rolls-Royce,
  a teddy bear.
- Screenshots of a screen rather than of a person.
- Faces already redacted to a black box by whoever published the screenshot.
- Group photographs, which show a crowd the persona is one face in. Publishing
  one puts a dozen uninvolved people on a page about state-sponsored fraud in
  order to show one of them. One image had the persona's own eyes redacted and
  every bystander's face — including a child's — left visible.
- **An identity document.** The registry tagged a Malaysian MyKad card, carrying
  a photograph, a full name and an ID number, as `face` rather than `document`.
  The tag filter did not catch it. The eye check did.

Two lessons are worth keeping. The registry's `document` tag is necessary and
**not sufficient** — filtering on it alone would have published a national ID
card. And a colour-count heuristic for spotting flat graphics was tried and
rejected: it flags greyscale photographs, and several genuine portraits here are
greyscale. Each rejection is recorded with its reason in the data file.

The captions say the image shows whoever appeared under the identity, which is
not necessarily the person whose details the identity was assembled from. That
distinction is the whole point of captioning them at all.
