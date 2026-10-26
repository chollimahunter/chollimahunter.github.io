# Mining OpenSourceMalware

OpenSourceMalware (OSM) publishes DPRK supply-chain reporting that this site
already cited once, for NullReceiver, without ever reading the rest of the
catalogue. This documents what is reachable there, what was taken, and the rules
that decided what was left behind.

## What is reachable without credentials

- `https://opensourcemalware.com/sitemap.xml` is a sitemap index. It points at
  `sitemap-0.xml` (15 site pages), `sitemap-1.xml` and `sitemap-2.xml`
  (100 `/npm/<package>` pages each), `sitemap-3.xml` (empty) and
  `sitemap-blog.xml` (69 `/blog/<slug>` posts).
- `https://opensourcemalware.com/rss.xml` lists the posts. Around 25 of the 68
  items mention DPRK, North Korea, Contagious Interview, Lazarus, NullReceiver
  or PolinRider.
- Pages are client-rendered. A plain fetch of any of them returns the same
  ~2.5KB HTML shell with no content, so reading one needs a browser.

There is a JSON API at `api.opensourcemalware.com`. It requires an API key,
returns a Supabase-style `No API key found in request` on `/health`, and the
site sells access. **Do not attempt to work around that.** Public pages and
feeds only; if something needs credentials, it is out of scope until the site
owner buys a key.

## What was taken, 2026-09-03

22 DPRK-relevant posts were read. The raw extraction is
`_drafts/osm-mining/2026-09-02-run.json` -- 212 entries, each carrying its
value, type, the exact page URL, the verbatim sentence that justifies it, and
the post's publication date. That draft is evidence, not content: nothing in it
is published by being there.

What reached the site from it is `src/_data/iocs/osm-malicious-package-versions.json`:
four bulk datasets, 39 version-pinned npm releases, registered in
`src/_data/iocIndex.js` alongside the other bulk datasets.

## The rules that decided what was left behind

**Versions, never bare package names.** For a compromised legitimate project
the package name identifies the victim, not the threat. `axios` has roughly 100
million weekly downloads and is not an indicator; `axios@1.14.1` is. This is
CONTENT_GUIDE's warning about package indicators, applied literally -- every
entry is `name@version`, and a bare name is dropped rather than published.

**A dataset's disclaimer travels onto its records.** `recordsFromDatasets` in
`iocIndex.js` sets each record's source context from the dataset's disclaimer,
because a bulk entry otherwise renders as a bare value beside a campaign chip.
`axios@1.14.1 -- Contagious Interview` with no further text reads as an
accusation against axios. This applies to every bulk dataset, not only this one.

**Non-atomic values are split.** The reporting writes
`tailwindcss-merge@1.0.1, 1.0.2, 1.0.3, 1.0.4` and
`plain-crypto-js@4.2.0 / @4.2.1`. Those are four indicators and two indicators,
and they are stored that way so a search for one version finds it.

**Unconfirmed attribution is not published.** One post's releases were dropped
because OSM's own text calls the actor unknown. Two further posts were declined
outright as not DPRK -- both attributed by OSM to TeamPCP. The site does not
inherit an attribution its source declines to make.

**Analysis artifacts are not indicators.** The draft holds XOR keys,
obfuscation seeds, template UUIDs, registry keys and RPC endpoint lists. None of
these is something a defender looks up in an index, and the RPC endpoints are
legitimate infrastructure being abused rather than attacker-owned. They stay in
the draft.

## What is still unmined

Roughly 170 draft entries: domains, GitHub accounts and repositories, file
hashes, Packagist packages, emails, and the TasksJacker identity cluster. Those
need the same per-entry judgment the packages got, and several carry the
threat-actor identity questions this site is most careful about -- the
TasksJacker cluster in particular is flagged because OSM's own DPRK confidence
there is only medium-high. The 200 `/npm/<package>` pages in the sitemap were
not read at all.

## Run file reviewed, 2026-09-09

`_drafts/osm-mining/2026-09-02-run.json` has now been read against the rules
above. It holds 212 entries; every one carries a resolvable
opensourcemalware.com URL, and none was promoted. The reasons, in the order the
rules appear above:

- **Already published.** Every `npm_package_version` candidate in the file,
  including four written as version ranges, is already in
  `osm-malicious-package-versions.json`. The original pass took the whole
  package-shaped set, so there was nothing left there to add.
- **Bare package names, 20 of them.** Ten npm and ten Packagist names with no
  version, dropped under the versions-never-names rule.
- **Analysis artifacts, 13.** XOR keys, obfuscation seeds, a template UUID,
  registry keys and five RPC endpoints the run file itself notes are legitimate
  public infrastructure the malware calls rather than anything attacker-owned.
- **Unconfirmed attribution, 13.** Two posts carry it. One states its threat
  actor is unknown and only the tradecraft is DPRK-like; the other says outright
  that attribution is not confirmed and overlap is not proof of authorship.
- **TasksJacker, 24.** The cluster this document already flagged. OSM gives high
  confidence for who owns the C2 and only medium-high for the DPRK link, and
  notes tradecraft that departs from the usual pattern. Within it OSM separately
  calls one GitHub account a compromised legitimate CI service account.

### The aggregated email list, and why it stays out

The list this document previously singled out is the one in OSM's VS Code tasks
post. Reading the post rather than the run file's copy of it settles the
question: the aggregated block holds sixteen addresses, not the twenty-two the
run file recorded, because the run file mixed the aggregate with per-variant
addresses from elsewhere in the same post.

More important than the count is what the block contains. OSM annotates its own
GitHub user list with `# potential compromised user` against one account, and
that account's `users.noreply.github.com` address sits in the email block. The
block also holds an address at a named company's domain belonging to a person
who appears to be that company's founder, and others at the domains of real
projects. Spoofing a real developer's address in commit metadata is ordinary
tradecraft for this campaign, so an address appearing in a malicious repository's
commits is as consistent with impersonation as with authorship, and the post
does not separate the two.

Publishing the block would therefore put at least one person OSM itself marks as
possibly compromised, and probably several more, into an index of DPRK
indicators. That is the same judgment the versions-never-names rule makes about
package names, applied to addresses: for a compromised project the identifier
names the victim. The list is not promoted, and splitting it into atomic entries
would not change that, because the problem is which addresses it contains rather
than the shape it is written in.

Individually attributed addresses elsewhere in the same post -- the ones OSM
gives underneath a named operator account as `<account> <address>` -- do not have
this problem and remain promotable. They were not taken in this pass.

The run file stays untracked either way: publishing the repository should not
publish the cutting-room floor.
