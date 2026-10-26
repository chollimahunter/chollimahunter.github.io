# Workflow: enrich-refresh

## Purpose

The enrichers record whether an account still exists, whether malware is
still online, and what OSV says about a package. The data workflows run only
the ones they need for what they add, so an answer given once would otherwise
never be checked again. `.github/workflows/enrich-refresh.yml` re-runs
`enrich-platform-accounts.js`, `enrich-github-accounts.js`,
`enrich-malware-status.js` and `enrich-osv-malicious.js` every Sunday at 05:20
UTC.

## How it works

The `enrich` job runs them with a read-only token and passes the four files
under `scripts/data/` to the `propose` job, which opens or updates the pull
request on `enrich/refresh` and dispatches the `ci` check on it. Each script
may fail without stopping the others; a failed one leaves its file as it was.

Avatars and the status written into `scraped-iocs.json` by
`enrich-github-accounts.js` are not carried into the pull request.
