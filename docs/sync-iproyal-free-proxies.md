# Tool: sync-iproyal-free-proxies

## Purpose

Keeps the `iproyal-free-proxy-ips` dataset inside
`src/_data/iocs/itworker-datasets.json` current against the free proxy list
IPRoyal publishes at `https://iproyal.com/free-proxy-list/`. Reporting on DPRK
remote-worker cases in 2026 names IPRoyal beside Astrill VPN as a service the
workers connect through, so an address from the list is labelled as a proxy
wherever it appears on the site, the way a Spur address is labelled as an
Astrill exit.

The page is IPRoyal's directory of free, public proxy servers. It is not the
company's paid residential pool, and the servers belong to third parties and
are used by anyone who finds the list. The dataset's disclaimer says so: a
match means a connection came through a public proxy IPRoyal listed on the
day the list was read, and nothing about who was behind it.

## How it works

1. The page renders its table in the browser by calling the site's
   `getFreeProxyList` action (`POST /_actions/getFreeProxyList/` with
   `{"page": n}`), so the script makes the same calls. It fetches the page,
   confirms the `FreeProxyListTable` script component it loads still calls that
   action, then pages through every record, ten a page (about 620 pages, three
   to four minutes, with a short pause between requests). The action answers
   in devalue's flat encoding, which the script unpacks itself. Until
   November 2026 the component read IPRoyal's CMS directly with a public
   token; that path is gone.
2. Keeps every address the index's own normaliser accepts and counts the rest
   as excluded, never guessed at. About one record in eight is excluded, nearly
   all of them Cloudflare edge addresses and network (`.0`) addresses.
3. Refuses to write if fewer than 20 addresses parsed, or fewer than half the
   entries already stored, and fails with a named reason if the page stops
   loading the component or the component stops calling the action. A
   change on IPRoyal's side produces a failed run, not a pull request that
   empties the list.
4. Deduplicates, sorts numerically, diffs against what is stored, and
   overwrites the dataset object in place with a fresh `sync.last_synced`.
5. Prints `CHANGED=true` or `CHANGED=false` as its last line; the workflow
   opens one pull request when any of the three syncs changed.

## Running it

```
node scripts/sync-iproyal-free-proxies.js
node scripts/sync-iproyal-free-proxies.js --from saved-records.json
```

The `--from` form reads a saved file of records (a plain array, or an object
with a `records` array), for a machine that cannot reach the site. The weekly run is `.github/workflows/sync-itworker-datasets.yml`;
a manual dispatch of that workflow runs it at once. The first run creates the
dataset object, so it is absent until then.

## Caveats

Free proxies rotate within days. The dataset is a snapshot the weekly sync
replaces, so an address may since have gone back to ordinary use; the
indicator page shows the sync date beside the network label for that reason.
