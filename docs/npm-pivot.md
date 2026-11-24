# npm pivot

`scripts/npm-pivot.js` reads the npm registry for every indexed malicious
package and npm publisher account, for what sits around them.

```
node scripts/npm-pivot.js collect [--force] [--limit N]
node scripts/npm-pivot.js rank [--max-downloads N]
```

A package's registry document records the maintainers with their email
addresses, the account that published each version, every version's
dependencies, and the repository, homepage and issue tracker it links. The
publisher's other packages come from the registry's search
(`maintainer:<name>`). On 23 November 2026 one indexed publisher turned out to
have five live packages beside the three its report named.

`collect` reads the registry document of every indexed `npm_package` (a value
pinned to a version, which names a compromised release of somebody else's
package, is skipped, as are values filed only under PolinRider or carrying
`attribution_doubt`), lists the packages of every indexed npm account and of
every publisher those documents name, and looks up the weekly downloads of
every dependency of a live indexed package. The registry needs no token and
nothing here touches the GitHub API, so it runs beside the GitHub pivots.
Results go to `_drafts/private/npm-pivot.json`. `NPM_GAP_MS` (default 250)
spaces the requests.

npm replaces a package it takes down with a "security holding package" that
keeps no maintainers, versions or links, so most indexed packages yield
nothing but their status; the pivot's value is in the ones still live and in
the publisher accounts, which outlive their packages.

`rank` prints five tables, each against what the index already holds:

- packages published by those accounts;
- publisher accounts of indexed packages;
- publisher email addresses;
- GitHub accounts and repositories the packages link;
- dependencies with `--max-downloads` (default 1,000) or fewer weekly
  downloads, which is what a loader layer looks like (a malicious package
  that depends on another to hide its payload).

A row is a lead. A publisher can be a hijacked maintainer whose own packages
are legitimate, a dependency can be an obscure honest library, and a linked
repository can be the project a typosquat imitates. A publisher listed with
dozens of old packages is the first sign that an indexed value is a false
positive rather than an operator's. Read each before filing, and keep the
results in the private repository.
