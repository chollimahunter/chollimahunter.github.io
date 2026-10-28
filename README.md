# Chollima Hunter

A public threat-intelligence tracker for DPRK state-sponsored cyber operations —
the people, the fabricated identities they work behind, and the identifiers
reported alongside them. Live at
**[chollimahunter.github.io](https://chollimahunter.github.io/)**.

Nothing here is original research. Every claim is drawn from a public record —
an indictment, a sanctions designation, a law-enforcement wanted notice, a
published threat-intelligence advisory, or a named researcher's post — and every
entry links back to the record it came from so a reader can check the source
rather than take this site's word for it.

## What's on it

| | |
|---|---|
| [Remote Workers](https://chollimahunter.github.io/remote-workers/) | A searchable index of the identity indicators — email addresses, GitHub and LinkedIn accounts, packages and more — filterable by type, activity cluster and whether the account is still live. Each has its own page. |
| [Personas](https://chollimahunter.github.io/remote-workers/personas/) | The fabricated professional identities these operations apply for work behind, each gathering the accounts and identifiers reported under it. |
| [Named IT Workers](https://chollimahunter.github.io/remote-workers/pictures/) | The real people named in law-enforcement notices, as distinct from the identities they operated behind. |
| [DPRK Hunting](https://chollimahunter.github.io/hunts/) | Ready-to-run threat-hunting queries and detection guidance. |
| [Repo Scanner](https://chollimahunter.github.io/repo-scanner/) and [EtherHiding Tracker](https://chollimahunter.github.io/etherhiding/) | Tooling and tracked findings for two specific techniques. The repositories the PolinRider campaign compromised are listed on the scanner's results page, and the on-chain infrastructure on the tracker; neither set appears in the Remote Workers index, because those name what was attacked rather than who ran the attack. |
| [Glossary](https://chollimahunter.github.io/glossary/) and [Resources](https://chollimahunter.github.io/resources/) | The naming conventions and campaign terms this reporting uses, and where to report DPRK activity to law enforcement. |
| [Sources](https://chollimahunter.github.io/sources/) | Every record the site cites, with what each one accounts for. |

The identity index is downloadable as
[CSV](https://chollimahunter.github.io/assets/data/ioc-index.csv) or
[JSON](https://chollimahunter.github.io/assets/data/ioc-index.json), and new
and revised profiles and hunts are published to an
[Atom feed](https://chollimahunter.github.io/feed.xml).

## Running it locally

Eleventy, no backend, no database. Node 20+.

```
npm install
npm start        # http://localhost:8080 with live reload
npm run build    # writes _site/
```

`.github/workflows/deploy.yml` builds and publishes on push. It deploys through
the Pages Actions pipeline, so the repository's Pages source has to be set to
"GitHub Actions" rather than to a branch, or the workflow succeeds and nothing
is served. The scheduled workflows that keep indicator data current, listed in
`docs/ci.md`, open a pull request rather than committing, and `main` takes a
change only through a pull request with a passing `ci` check.

`src/_data/site.json` holds the site URL, the contact address, and the Ko-fi
link. While the contact address is empty or still contains the substring
`TODO` the site degrades rather than breaks: the submission page is replaced
by a notice pointing at GitHub issues, the footer and About page show no
contact link, and `/.well-known/security.txt` is not written at all.

## How data gets in

Indicators come from four paths, and each carries a provenance label on the site
so a reader can weigh it:

- **Scraped** — `scripts/scrape-dprk-iocs.js` extracts indicators from the
  published reports listed in `src/_data/iocs/scrape-sources.json`, reading
  prose only and never a page's links. See `docs/scrape-dprk-iocs.md`.
- **Bulk datasets** — identifier lists a report publishes wholesale, ingested
  under one dataset-level citation. See `docs/sync-dtex-itworker-emails.md`.
- **Researcher posts** — persona dossiers transcribed by hand from researchers
  on X, which the scraper cannot reach. See `docs/x-dossiers.md`.
- **Curated rulesets** — hand-written entries where a person judged the polarity
  of an indicator, such as a malicious package versus the one it impersonates.

Adding content is documented in `CONTENT_GUIDE.md`. `CLAUDE.md` covers the
repo's conventions.

## Licence

Site content and data are published under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and the code under
the MIT licence; see [LICENSE](LICENSE) for the split and for what the licence
does not cover. Indicators are marked TLP:CLEAR. Security reports go through
[SECURITY.md](SECURITY.md).

## A word on what this is not

Presence in this index is **not** proof of DPRK affiliation, of wrongdoing, or
even that a listed identifier is still in use. These operations routinely apply
for work under the identity of a real, uninvolved person, so a name or an
account here may belong to someone with no connection to any of it and no idea
they appear. Individuals named in law-enforcement notices are alleged to have
done what the issuing agency says, and are presumed innocent unless and until
proven guilty. Treat every entry as a lead that requires independent
investigation, never as a finding.

Corrections and removal requests are welcome — open an issue, or use the
[submission form](https://chollimahunter.github.io/submit/).
