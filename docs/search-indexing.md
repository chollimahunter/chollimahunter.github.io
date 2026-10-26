# Search engine indexing

What the site does to be found by search engines, what is automated, and the
things that can only be done from a search engine's own console. The goal it
serves: a search for an exact value the site holds, such as an email address,
a wallet or a GitHub login, should return that value's page.

## What the build ships

Every indicator the site holds, about 20,000 of them, has an indexable page
at `/indicators/{id}/` with a canonical URL pointing at itself. That includes
the roughly 2,500 values that also appear on a persona page. Until
2026-09-24 those were `noindex` meta-refresh stubs pointing at the persona
page and were left out of the sitemap. That meant a search for one of those
email addresses could only match a persona page titled with a persona's name
and holding dozens of other values, and a
`noindex` page with a canonical to a URL fragment gives Google nothing to
index under the value itself. They are now real pages. The persona page is
unchanged apart from linking each value's heading to its own page, and each
value page summarises the persona and links back, so the two are not
duplicates: one is about an identity, the other about one value.

An indicator page carries the value in the `<title>` (the value, then the kind
of value, then "(DPRK)"), the `<h1>`, the meta description and
the first sentence. That sentence gives the type and the campaign. The next
names how many published sources reported the value and who published them.
Below come each citation with its context quote, and a "Related indicators"
section of ordinary links, with the value as anchor text, to the other values filed
under the same persona (capped at the site's list limit) and to the values
either side of this one in each of its first three sources. The neighbour
links run in a ring, so nearly every page is linked from other indicator
pages as well as from the browse listing. The extra fields come from
`indicatorPageData()` in `src/_data/iocIndex.js`. A page can set `head_title`
to give its `<title>` more than its heading, which is how `base.njk` builds
the indicator titles.

Every page carries a meta description, a canonical URL, Open Graph and Twitter tags and
an Atom feed link, all set in `src/_includes/base.njk`. The pages marked
`noindex` are the 404 page and the redirect stubs written by
`layouts/redirect.njk` (`/clusters/`, `/remote-workers/linkedin-candidates/`
and hunt ids that moved). None of these
is an indicator page, and `npm run check` fails if any `noindex` page appears
in a sitemap.

`partials/structured-data.njk` adds JSON-LD to every page: a `BreadcrumbList`
built from the URL, and on the home page a `WebSite` with the indicator
search as its `SearchAction` and an `Organization`. An indicator page gets
the breadcrumb only. A `Dataset` describes a downloadable collection, which a
single value is not, and no Google feature reads `DataFeedItem`. No page
declares a `Person`. A search engine reads a `Person` record as a fact about
that person, and the site's position is that it cites public records rather
than asserting identities itself.

## Sitemaps and crawl paths

`robots.txt` allows everything and names `/sitemap.xml`, a sitemap index. It
points at `/sitemap-pages.xml`, which holds every indexable page that is not
an indicator (740 URLs), and at `/sitemap-indicators-N.xml`, one file per
5,000 indicator pages (five files at 21,427 pages). Every file is far under
the 50,000-URL and 50 MB limits: the largest is about 640 KB. The runs are
cut in `src/_data/iocIndex.js`, so the index and the files it names cannot
disagree. As of the 2026-09-28 build, the sitemaps list exactly the
indexable pages: 22,167 URLs, each with a self-canonical and no `noindex`.
The whole build writes about 24,700 pages; the rest are redirect stubs and
other pages kept out of the index.

`<lastmod>` on an indicator URL is the latest date its page content moved.
That is the latest of the record's `last_seen`, the dates this site pulled
each of its citations, and any account, network or telephone-line check. A
persona page's `<lastmod>` is the latest of its indicators'. The build date
is deliberately not used: it would claim every page changed on every deploy,
and Google stops trusting a sitemap's dates once it finds them wrong.

The searches on `/remote-workers/` and the cluster pages render their results
in the browser, so they give a crawler no links. The browse listing does
that job instead. It has one run of plain pages per indicator type, 200 values
to a page, at `/indicators/browse/{type}/` and `/indicators/browse/{type}/{n}/`,
so each page holds one kind of value and says so in its title ("Email addresses
in DPRK threat reporting, page 3 of 28"). Each row links to the indicator page
with the value as the anchor text. `/indicators/browse/` and `/indicators/`
both carry the directory of every run page. The home page links to
`/indicators/`, so every indicator page is three clicks from the home page:
home, `/indicators/`, a run page, the indicator. The browse URLs changed from
`/indicators/browse/{n}/` on 2026-09-24; the old ones now 404, which costs
nothing because they held no content of their own.

## Thin content

An indicator page holds about 100 unique words: the value, a lead sentence,
the citations and their quotes. Expect most of the roughly 22,000
near-duplicate pages to sit in "Crawled - currently not indexed" however
they are submitted. The mitigation in place is the lead sentence, the named
publishers, the context quotes and the ring of related links described above.
Two levers remain. Request indexing by hand for the high-value types, which
are email addresses, wallets and GitHub accounts. And consider leaving bare
bulk-list file hashes out of the sitemap, since they carry the least context.
That exclusion is not implemented.

## Duplicate values

Twenty-four values exist as two records under two types. Twenty-two are a
curated `domain` and a scraped `hosted_site` for the same `*.vercel.app` host,
and two are a `smart_contract_address` and a `wallet_address`. Each pair has
two pages with the same value in the title, which splits whatever ranking
the value earns. The fix belongs in the merge in `iocIndex.js` rather than in
the templates. Treat a `hosted_site` whose value is a bare host as the same
indicator as a `domain` of that host, and a contract as the same indicator
as a wallet of that address, and merge the citations into the survivor (the
curated type). Then either keep the loser's page as a real page whose
canonical names the survivor and leave it out of the sitemap, or stop
generating it and write a redirect stub for its URL. The first keeps every
cited URL working and is the one to prefer. Record ids are unchanged either
way.

## IndexNow

IndexNow is one endpoint shared by Bing, Yandex, Naver, Seznam and Yep. A
POST naming the URLs that changed makes each of them fetch those pages
within minutes rather than on the next crawl. Google does not take part; it
reads the sitemap.

The site proves it owns the host by serving the key at `/<key>.txt`
(`src/indexnow-key.njk`, key in `src/_data/site.json`), so the key is public
by design. `scripts/indexnow-submit.js` does the submitting, and the deploy
workflow runs it in two halves because the build and the publish are
separate jobs:

- In the build job, `--plan` compares the sitemaps in `_site` with the ones
  the live site is serving and writes the URLs that are new, carry a
  different `lastmod`, or are live but no longer in the new sitemaps (they
  now answer 404 or 410, which IndexNow accepts) to an artifact. If the live
  root sitemap or any child cannot be fetched after one retry, there is no
  baseline to compare with, so the plan is empty and nothing is submitted.
- In the deploy job, after the pages are live, `--submit` posts that list.

Every fetch has a 30-second timeout and one retry after a short backoff.
A failure is logged, never fatal: the deploy is already live and the next
one resubmits whatever is still different from what was live. To submit
everything once, for instance after the key changes, build and run
`node scripts/indexnow-submit.js --all`. The first deploy after the
2026-09-24 change submits most of the indicator URLs once, because about
2,500 are new and many `lastmod` values moved to the pull date. The script
posts in batches of 10,000.

## Google Search Console

The property is `https://chollimahunter.github.io/`, verified by the meta
tag in `base.njk`.

The current state is read daily by `.github/workflows/check-indexing.yml`,
which asks the URL Inspection API about the hub pages and a rotating sample
of 40 indicator pages and writes the answer to the run summary; it needs the
`GSC_SERVICE_ACCOUNT` secret. When the property was first read by hand, on
2026-09-24, Google had indexed 5 pages and both submitted sitemaps showed
"Couldn't fetch", although the live files were served correctly.

What remains to be done by hand, in order of effect:

1. Sitemaps: if `/sitemap.xml` still shows "Couldn't fetch" a week after
   submission, remove it and submit it again. If that does not change it,
   submit `https://chollimahunter.github.io/sitemap.xml?v=2`. Google treats
   that as a new URL and fetches it afresh, and GitHub Pages ignores the
   query string. Also submit one indicator file directly, for example
   `sitemap-indicators-1.xml`, so its coverage reports separately.
2. URL inspection on `/sitemap.xml` itself, then "Test live URL". This
   confirms Google can fetch it and often unsticks the status.
3. URL inspection with "Request indexing", about ten a day. Start with
   `/indicators/`, `/indicators/browse/`,
   `/indicators/browse/email-address/`, then the home page and the section
   hubs. After that, request indicator pages for the values people are most
   likely to search, such as widely reported operator email addresses. Each
   request also gets that page's links crawled.
4. Watch the Page indexing report weekly. Expect "Discovered - currently not
   indexed" to take most of the 20,000 at first, then to drain into Indexed
   or "Crawled - currently not indexed" over four to twelve weeks. A large
   "Crawled - currently not indexed" count means Google judged those pages
   too thin to keep. The related-indicator links and the lead sentence are
   the site's answer to that, and more cited context per value is the only
   further one. Each page's "Related indicators" section adds up to twelve
   values that differ from page to page, drawn first from the same persona
   record and then from the same cited reports, a type at a time so a hash page
   also lists the sample's addresses and hosts.
5. Once indexed pages appear, check Performance with a query filter on `@`
   to see whether email searches are landing on indicator pages.

Expected timelines: a fresh property on a new host is crawled slowly and
earns crawl budget as pages prove useful. Days for the hubs after an
inspection request, weeks for the first thousands of indicator pages, and
months before most of 20,000 low-link pages are indexed. Some will never be.
Google indexes a share of any large set of similar pages, not all of it.

A custom domain would help modestly and slowly. On `github.io` the site shares
a host with many unrelated pages, a domain the site owns can build a
reputation of its own, and Search Console can then use a Domain property
covering every subdomain and protocol. The cost is a new host to verify, and
301 redirects from the `github.io` URLs, which GitHub Pages serves itself when
a custom domain is set. Any ranking the old host has earned carries over
through those redirects. It does not change what gets indexed in the first
months. Crawl budget follows links and usefulness, and a new domain starts
with neither. It is worth doing early if it is going to happen at all, since
every month on `github.io` is ranking history to move later.

### Daily index check

`.github/workflows/check-indexing.yml` runs `scripts/check-indexing.js` each
day. It asks the URL Inspection API about the hub pages and a rotating sample
of 40 indicator pages, and writes each page's verdict, coverage state and last
crawl to the run summary. The API allows 2,000 inspections a day per property.

It signs in as a service account in the Google Cloud project `chollima-510005`
(where the Search Console API is enabled). Setting it up is a one-off done by
hand: create the service account with no roles, create a JSON key for it, add
its email as a Restricted user on the `https://chollimahunter.github.io/`
property in Search Console, and store the key as the repository secret
`GSC_SERVICE_ACCOUNT` (`gh secret set GSC_SERVICE_ACCOUNT < key.json`, then
delete the file). Until the secret exists the workflow passes without checking.

## Bing Webmaster Tools

Bing's index also feeds DuckDuckGo, Yahoo and Ecosia. Signing in to
[Bing Webmaster Tools](https://www.bing.com/webmasters/) with a Microsoft
account offers to import the site from Google Search Console, which copies
the verification and the sitemap in one step. IndexNow submissions show up
there under IndexNow once the key file is live.

## What does not help

Submitting the same URLs repeatedly, adding `lastmod` dates that are not
real, or listing the site in link directories. Google's own guidance is that
a sitemap and ordinary links are what it wants, and that thin pages are
indexed slowly however they are submitted. The indicator pages are short by
nature. The lead sentence, the named publishers, the context quotes and the
related links give each one some substance and a place in the link graph.
The rest is time.
