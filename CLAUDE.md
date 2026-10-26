# Chollima Hunter

## Start of every session: read two files

`_drafts/` is not part of this repository. It is the maintainer's private
repository, checked out inside this one and ignored by it. When it is present,
read before anything else:

1. **`_drafts/working-rules.md`**: the maintainer's standing rules, each with
   its reason. Follow them. When the maintainer sets a new standing rule, add
   it there in the same session.
2. **`_drafts/next-session.md`**: the work saved for a later session. When the
   maintainer asks to save something "for next session", add it there; when an
   item is finished, delete it there.

Commit and push changes to either in the `_drafts/` repository itself. Never
keep a rule or a to-do list only in local memory, which no other session sees.

**Nothing private goes into this repository**, which is public: no withheld
values, leads, research notes naming people, evidence captures, or details of
the maintainer's accounts, machine or identity. Withheld values that a public
script must recognise are sealed (`scripts/lib/private-data.js`, `npm run
seal`); everything else of that kind lives under `_drafts/private/`.

## What this is

Chollima Hunter tracks, documents, and exposes DPRK state-sponsored cyber campaigns, actors, and infrastructure. It's a static site built with Eleventy — there is no backend, no database, and no API. Every page is generated at build time from files under `src/`, and the `/submit/` page sends submissions by email (a `mailto:` link) rather than to any code in this repository or any third-party service. Beside the profiles, hunts, clusters and indicator searches, it carries `/guidance/` ("If you find a match": guidance for employers and for people who are listed) and `/data/` ("Data and downloads").

## Stack and dev commands

Eleventy 3.x with Nunjucks templates (`templateFormats: ["njk", "md", "html"]`), no `pathPrefix` (the site deploys to the root of GitHub Pages).

- `npm run build` — runs `eleventy`, writes to `_site/`.
- `npm run check` — runs `scripts/check-site.js` over `_site/`: broken internal links, inline styles, h1 count, duplicate ids, images without alt, leaked template variables, and unparseable sitemap or feed XML. The deploy workflow runs it after the build and fails on any finding. Run it before pushing a template change.
- `npm run check:css` — runs `scripts/check-css.js` over the sources: fails on a selector list declared twice in the same at-rule context of `tokens.css`, a class used in `src/**/*.{njk,md,html}` or `src/assets/js/*.js` that `tokens.css` does not define (silence a deliberate one with `{# css-allow: name #}` or `// css-allow: name`), a `style=` attribute, or a hex colour outside `:root` (mark a necessary one `/* css-allow */`), and warns on classes defined but unused; it runs after `check` in `npm test`, `ci.yml` and `deploy.yml`.
- `npm run validate` — runs `scripts/validate-data.js` over the data files themselves, before anything is built: enums (`confidence_level`, `hunt_type`, campaign labels), cross-file references (a profile's `cluster_taxonomy` against `taxonomy.json`, a hunt's `campaign_tags` against a cluster's `hunt_tags`, a redirect's target against `hunts.json`), and normalizer round-trips (an indexed email or phone number already in its canonical form). It reads the IOC data the same way `src/_data/iocIndex.js` does — by building the same merged index — so it checks exactly what the site would publish rather than a second copy of the rules. Fails closed: exits 1 with one line per finding, 0 when clean.
- `npm run audit:integrity` — runs `scripts/audit-integrity.js`: structural consistency of the indicator files (duplicate ids, a source both read and declined, records with no citation, values that no longer normalize to themselves, persona images nothing references) and of the built search payload against the index. Exits 1 on any finding; CI and the deploy run it after the unit tests, so run it after a build. `scripts/audit-indicators.js` is different: a triage heuristic for values that sit beside victim or vendor language, run by the weekly scrape on that run's new records and listed in its pull request for review, never a gate.
- `npm run test:unit` — runs `node --test` over `scripts/lib/**/*.test.js`: table-driven tests for the normalizers in `scripts/lib/ioc-normalize.js` (Gmail dot/plus folding, E.164 phone canonicalization, wallet-chain detection by address shape, file-hash validation), plus a timing regression on the bounded email and LinkedIn regexes against a pathological input.
- `npm test` now runs `validate`, then `build`, then `check`, then `check:css`, then `test:unit`, then `audit:integrity` (the full `ci` sequence), in that order, so a bad data record fails in under a second rather than after a 40-second build.
- The sitemap is an index: `src/sitemap.njk` names `/sitemap-pages.xml` (every non-indicator page; a new static route goes in its list) and one `/sitemap-indicators-N.xml` per 5,000 indicator pages, both cut from lists in `src/_data/iocIndex.js`. `/indicators/browse/` is the rendered link to every indicator page, which is what lets a crawler reach them. The deploy workflow submits changed URLs to IndexNow; `docs/search-indexing.md` covers what is in place for search engines and what still has to be done by hand in Search Console and Bing Webmaster Tools.
- `npm run serve` / `npm start` — runs `eleventy --serve`, serving on `http://localhost:8080` with live reload. The dev server builds only a 400-page sample of `/indicators/{id}/` pages, up to an equal share of each indicator type, which is what makes it start in about 5 seconds instead of 46; links to the rest of the roughly 21,400 indicator pages will 404 locally. Run `ELEVENTY_ALL_INDICATORS=1 npm run serve` when working on those pages or on the `/remote-workers/` search. `npm run build` is never sliced — see `indicatorPages()` in `src/_data/iocIndex.js`.
- Deployment is handled by `.github/workflows/deploy.yml`: it runs `npm ci`, `npm run validate`, `npm run build`, then `npm run check` and `npm run test:unit` (each fails the job on any finding), plans an IndexNow submission for the URLs that changed, publishes `_site` to GitHub Pages, and submits that plan to IndexNow once the pages are live — no ORPHEUS-style build step involved.
- `.github/workflows/ci.yml` runs the same `npm ci`, `validate`, `build`, `check`, `check:css` and `test:unit` sequence on every pull request to `main`, as the check named `ci`, and deploys nothing. Pull requests opened by the scheduled workflows are validated by a `ci` run each of them dispatches on its branch, since a pull request opened with `GITHUB_TOKEN` triggers no `pull_request` run. See `docs/ci.md`.
- `npm run preview` — serves the built `_site` on `http://127.0.0.1:8081` through `scripts/serve-built.js`, for checking a build in a browser. It refuses to start when the port is taken and stops itself after 15 idle minutes (60 at most), so it cannot be left running. A PreToolUse hook (`.claude/hooks/guard-servers.js`, wired in `.claude/settings.json`) refuses Python and npx throwaway static servers outright, and refuses a second `eleventy --serve` / `npm run serve` / `npm start` while port 8080 is taken; it ignores text that only mentions them (quoted strings, heredocs). Throwaway servers were left running twice before this existed.
- Maintainer-only pages are registered by `_drafts/private/eleventy.js`, and only in a private build (`src/_data/privatePages.js`): `npm run build` never writes them and they are never deployed. View them with `npm run serve`, or with `ELEVENTY_PRIVATE_PAGES=1 npm run build` followed by `npm run preview`.

### Stopping a dev server on Windows

`pkill -f "eleventy --serve"` from a Bash shell does NOT kill it. Bash-tool
`pkill` does not reach native Windows processes, it exits 0 anyway, and the
server keeps running and keeps watching the repo. Use PowerShell instead:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*eleventy*" -and $_.CommandLine -like "*--serve*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Match on `*eleventy*`, not `*@11ty/eleventy*`: the real process spawned through
`npx` has the path with BACKSLASHES (`@11ty\eleventy\cmd.cjs`), so a
forward-slash wildcard kills only the `npx` wrapper and leaves the server alive.

This matters more than it sounds. Eight of these once accumulated in one
session, holding 21.5 GB between them, each still watching and rebuilding all
4,600+ pages on every file change (a full build now writes about 24,700). The symptoms do not look like stray
processes: `rm -rf _site` fails with "Directory not empty" (the watchers hold
file locks), a full build takes 288 seconds instead of 66, and `_site` picks up
orphan pages from a watcher rewriting it mid-build. If any of those three
appear, count the node processes first.

The site ships twelve client-side scripts, all progressive enhancement. `src/assets/js/site-utils.js` is the shared helper file the others use (`window.siteUtils`): it renders nothing, and `base.njk` loads it on every page ahead of every other script. Every search renders its box through `partials/search-box.njk` (live count beside the label) and offers the same four things: search, filters where the data has a natural dimension, Sort, and Download. The indicator searches render their results as a `.results-table` (`partials/ioc-table.njk`) whose column headers sort the whole result set, and get Download (STIX 2.1, MISP, CSV, text, JSON) from `ioc-search.js` via `partials/ioc-download-controls.njk`; every search over page content (each table search through `partials/table-filter.njk`, and the `/hunts/` and personas grids) gets them from `partials/result-tools.njk` and the global `src/assets/js/result-tools.js`. Four are global UI components loaded from `base.njk` on every page after the helpers: `result-tools.js`, `table-sort.js` (below), `src/assets/js/filter-dropdown.js`, which renders every filter-chip group (`.filter-chips[role="group"]`) and every native `<select>` as the same searchable dropdown, clicking the hidden chip or setting the hidden select so each page script still owns its state, and `src/assets/js/table-stack.js`, which labels every `.results-table` cell from its header and, below 64rem, stacks tables of four or more columns into cards. A new filter or select needs no wiring: write the chip group (via `partials/filter-chips.njk`, with a `short` label) or the `<select>` (with `aria-label` and `data-short-label`) and it becomes the site dropdown. `src/assets/js/ioc-search.js` powers the search on `/remote-workers/` — it downloads a compact index because the page cannot hold the roughly 19,000 records it searches — and the same script, given a `data-ioc-scope` attribute naming a cluster's campaign labels, powers the indicator search on each `/clusters/{id}/` page, and given a `data-ioc-index` attribute naming its own index file, the repository-indicator search on `/repo-scanner/`. `src/assets/js/table-filter.js` filters a table already rendered in the page, and drives the search on `/sources/`, the citations table on every cluster page and the scan-match table on `/repo-scanner/`. `src/assets/js/hunt-filter.js` narrows the card grid on `/hunts/` by hunt type and query language, `src/assets/js/persona-filter.js` does the same for the persona grid on `/remote-workers/personas/`, `src/assets/js/register-filter.js` narrows rendered table rows by a chip group carrying `data-row-filter` (the priority filter on `/remote-workers/red-flags/`; a chip group marked `data-multiple` takes several choices, which `filter-dropdown.js` renders as a multi-select), `src/assets/js/grid-more.js` caps a card grid at `limits.list` and reveals the rest on a click (the profile grids on the home page, `/profiles/` and `/remote-workers/pictures/`), `src/assets/js/query-copy.js` puts a copy button on each query on a `/hunts/{id}/` page, and `src/assets/js/table-sort.js`, loaded from `base.njk` because tables sit in a dozen layouts, makes every `.results-table` with a header row sortable by column (a table carrying `data-no-sort` is left alone). All of them hide their own control in the markup and reveal it on load, so a reader without JavaScript gets the full content rather than a dead widget. Everything else is static. Scheduled workflows keep indicator data current: gh-analyzer.yml runs gh-fake-analyzer over the index's GitHub accounts daily (docs/gh-fake-analyzer.md), and the dataset sync and weekly scrape keep indicator data current, while enrich-refresh.yml re-runs the status enrichers weekly (docs/enrich-refresh.md); every one of them opens a pull request rather than committing, and the three trusted ones (EtherHiding, gh-analyzer, enrichment refresh) merge it themselves once the dispatched `ci` run is green, behind the `AUTO_MERGE` env toggle and the `merge-when-green` action (docs/ci.md) — see `docs/sync-dtex-itworker-emails.md`, `docs/sync-spur-astrill-ips.md`, `docs/sync-iproyal-free-proxies.md` and `docs/scrape-dprk-iocs.md`. Five more workflows: etherhiding-refresh.yml re-reads the EtherHiding watchlist every other day and etherhiding-hunt.yml hunts for new contracts monthly (docs/etherhiding-contract-check.md, docs/etherhiding-hunt.md); check-indexing.yml asks Search Console daily which pages Google has indexed (docs/search-indexing.md); repo-copy-scores.yml is dispatch-only (docs/repo-copy-scores.md); and x-sweep-reminder.yml opens an issue monthly for the hand sweep of X sources; handle-pivot.yml is dispatch-only (docs/handle-pivot.md). The weekly scrape first runs `scripts/discover-sources.js`, which queues newly published articles from the feeds in `scripts/data/feeds.json` into `discovered[]` in `scrape-sources.json` for review (`docs/discover-sources.md`); it then reads unread sources and rechecks a rotating slice of read ones for changed text, with a full re-extraction monthly. IP indicators carry a network kind (fixed line, mobile, data centre, proxy, or a named VPN) from `scripts/enrich-ips.js`; run it after anything that adds IP addresses — see `docs/ip-network-types.md`. Malicious repositories and npm/PyPI packages carry a LIVE MALWARE or TAKEN DOWN badge from `scripts/enrich-malware-status.js`, which writes `scripts/data/malware-status.json`; rerun it after adding any. Domain indicators whose value is itself a registrable domain (never a subdomain) carry a registration date, registrar and status from the registry's RDAP record, written by `scripts/enrich-domains.js` to `scripts/data/domain-registration.json`; rerun it after adding domains. The same packages are cross-checked against OSV MAL- advisories by `scripts/enrich-osv-malicious.js` (`docs/osv-malicious.md`). Accounts on platforms other than GitHub and LinkedIn get a live/removed status from `scripts/enrich-platform-accounts.js` (only platforms that answer a missing profile honestly; Fiverr, Medium, Trello and X stay unchecked); run it after adding such accounts.

## Frontend conventions

**Strict rule: one global UI.** Every UI element looks and behaves the same everywhere it appears: filters, dropdowns and selects, tables, buttons, badges. A change to one is made in the shared component (a partial, a `tokens.css` class, or a script loaded from `base.njk`) and applied to every page that has the element in the same change, never to one page alone. Before editing, grep `src/` for every other use of the element; after, check each of those pages. No page may scroll horizontally at any width.

All styling lives in one file, `src/assets/css/tokens.css` — design tokens as CSS custom properties, plus a set of reusable component classes (`.card`, `.card-grid`, `.badge--*`, `.results-table`, `.tag-chip`, `.disclaimer-banner`, `.tab-bar`, `.table-scroll`). No inline `style=` attributes anywhere in the site — reuse an existing token or class, or add a new named class to `tokens.css` if a genuinely new pattern comes up.

Layouts chain through Eleventy's data cascade: a page sets `layout: base.njk` (or `layouts/profile.njk`) in its front matter rather than using `{% extends %}`. A layout that sits mid-chain uses `{% block content %}`; a leaf page template doesn't need one. Reuse markup through `{% include %}` partials before copy-pasting a block a third time.

See the `frontend-ui` skill for the full checklist and for how to verify changes visually with the Playwright MCP tools against the local dev server.

## Content conventions

Site prose is formal, neutral, and third-person, and every factual claim about a named individual needs a citation in that entry's `sources[]`. `CONTENT_GUIDE.md` documents the mechanics of adding a profile, a hunt, an IOC entry, or a bulk identifier dataset — read it before editing any content data file. When a source names an account on a platform the normalizer has no type for (a freelance, job or profile site), add the platform to `PLATFORM_ACCOUNTS` in `scripts/lib/ioc-normalize.js` and carry the value as an indicator in the same pass; never park it in `unextracted[]` for lack of a type. The build enforces this: `scripts/lib/dossiers.js` fails on a parked link that already normalizes unless its note says why it is held back. The `content-style` skill covers tone: no emojis anywhere (including in commit messages and PR descriptions), and prose over bullet lists for narrative sections.

## Backend status

There is no backend today. If a task ever proposes adding one — a server, an API route, a database — read the `backend-guidance` skill first; it covers why that decision needs to be surfaced explicitly (GitHub Pages can't run server-side code, so this would change the deployment model) before any implementation starts.

## Delegate to cheaper models where the work allows it

Prefer spawning a subagent on a smaller model over doing bounded, mechanical work
on the main thread. Pass `model` explicitly on the Agent tool — `"haiku"` or
`"sonnet"` — rather than letting it inherit the parent model. Reserve the main
thread for the judgment calls: what gets published, how an indicator is
attributed, what a diff means.

- **Haiku** — mechanical and well-specified, where the answer is checkable.
  Reading a run file in `_drafts/iocs/` and tallying indicators by type, checking
  every `sources[]` entry in `src/profiles/*.json` is non-empty, listing which
  `ioc_type` values appear across the `src/_data/iocs/` files, confirming a build
  wrote the files it should have.
- **Sonnet** — needs reading comprehension but not final say. Sweeping the
  codebase to find where a pattern is used, summarizing what a threat-intel
  source actually claims, drafting a first pass at a tool doc, reviewing scraper
  output for obvious false positives before a human looks at it.
- **Opus (main thread)** — anything that decides what the site asserts about a
  named person, sets a `confidence_level`, judges indicator polarity, or writes
  the final wording of a disclaimer.

Two things that make delegation actually pay off here:

- **Send the conclusion back, not the files.** The win is that a subagent reads
  twenty files and returns three sentences. A task defined as "read X and report
  back everything" spends more than doing it inline.
- **Don't delegate a single known lookup.** If the file and the symbol are
  already known, read it directly — spawning an agent to do one `grep` costs more
  than the `grep`.

Note that `subagent_type: "fork"` always runs on the parent's model and ignores a
`model` override, so a fork is never the cheap option. Use a fresh agent when the
point is to save tokens.

Good candidates in this repo, concretely: reviewing a fresh scrape run for vendor
boilerplate that slipped past the exclusion layer in
`scripts/lib/ioc-normalize.js`; cross-checking that every new record in
`src/_data/iocs/scraped-iocs.json` has a resolvable source URL; verifying a
template change didn't reintroduce an inline `style=` attribute anywhere in
`_site/`.

## Project skills

Four project-specific skills live under `.claude/skills/`, layered on top of the plugins already enabled for this repo (`code-review`, `security-guidance`, `frontend-design`, `playwright`, `skill-creator`, `github`):

- `repo-code-review` — efficiency, unnecessary comments, security, and correctness bugs, scoped to this repo's actual stack.
- `frontend-ui` — no inline CSS, component reuse, visual consistency, and Playwright-based verification against the dev server.
- `backend-guidance` — forward-looking guidance for if a backend is ever proposed; this repo has none today.
- `content-style` — tone, emoji policy, and citation requirements for both site content and Claude's own writing in this repo.


## History

This repo previously used `.orpheus/`, a custom multi-agent orchestration scaffold, to originally build out its features (profiles, hunts, the repo scanner, the EtherHiding tracker, submission intake). That scaffold has been removed now that everything it was designed to build exists as ordinary static content. At the time of removal, the one real operational script it contained, `scripts/sync-dtex-itworker-emails.js` (which the weekly `sync-itworker-datasets.yml` workflow runs), and its accompanying tool docs under `docs/`, were preserved rather than deleted.
