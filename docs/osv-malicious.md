# OSV malicious-package cross-check

`scripts/enrich-osv-malicious.js` looks up every `npm_package` and `pypi_package` indicator by name in OSV (`POST https://api.osv.dev/v1/querybatch`, then `GET /v1/vulns/{id}` for each MAL- id) and writes `scripts/data/osv-malicious.json`. MAL- advisories are the ones the OpenSSF malicious-packages project publishes into OSV. No token is needed; the script batches 500 packages per request and pauses between calls.

Run it with `node scripts/enrich-osv-malicious.js` after adding packages. The file records, per package name, the advisories found (id, published date, modified date, summary), or an empty list when OSV held none. A package whose lookup failed is left out rather than recorded as having none.

`scripts/lib/osv-malicious.js` attaches the advisories to each record as `osv_advisories`, and `partials/ioc-detail.njk` lists them on the indicator page with the published date, each id linked to `https://osv.dev/vulnerability/{id}`. A package with an empty list is a candidate to report upstream to the malicious-packages project.
