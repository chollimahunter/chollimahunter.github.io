# Tool: sync-spur-astrill-ips

## Purpose

Keeps the `spur-astrill-vpn-ips` dataset inside
`src/_data/iocs/itworker-datasets.json` current against the list of Astrill
VPN exit addresses Spur published on 19 December 2024 alongside its post
"Astrill VPN and DPRK Remote Worker Fraud". Spur's business is attributing
anonymising infrastructure, and it released about 2,400 addresses it recorded
as active that day because its customers kept reporting fraudulent
remote-worker applications arriving through them.

Every address the dataset carries is labelled `Astrill VPN` wherever it
appears on the site: as a chip on its search row, and under "Network" on its
indicator page. That label is what the dataset is for. A reader who finds one
of these addresses in a login record learns which VPN was used, which is the
fact Spur published the list to make available, and nothing about who used
it.

## How it works

1. Fetches `https://storage.googleapis.com/spur-astrill-vpn/ips.txt`, the
   plain-text file the post links, one IPv4 address per line.
2. Keeps every line that is a single well-formed IPv4 address and counts the
   rest as excluded, never guessed at.
3. Refuses to proceed if fewer than 100 addresses parsed. A near-empty answer
   means the bucket moved or the file was replaced, and the right response is
   a failed run rather than a pull request removing two thousand entries.
4. Deduplicates, sorts numerically, diffs against what is stored, and
   overwrites the dataset object in place with a fresh `sync.last_synced`.
5. Prints an added/removed summary and a final `CHANGED=true` or
   `CHANGED=false` line for the workflow to branch on.

## What a match means, and what the disclaimer says

An Astrill exit is shared by every customer of the service. The dataset's
`disclaimer` field, which the build carries onto every record, says so in as
many words: a match is a reason to look at the account behind a connection,
not evidence about the person. It also says that the list is a snapshot of
one day, that VPN exits are reassigned, and that an address on it may since
have been returned to its hosting provider and given to someone else.

The dataset's `confidence_level` is `low` for the same reason, and it is
tagged `IT Worker Fraud` alone: the post is about remote-worker applications,
not about the Contagious Interview lures.

## Running it manually

```
node scripts/sync-spur-astrill-ips.js
```

Then run `node scripts/enrich-ips.js` so any new address gets its network
lookup (see `docs/ip-network-types.md`). The Astrill label itself does not
depend on the lookup; it comes from dataset membership at build time.

## Running it on a schedule

`.github/workflows/sync-itworker-datasets.yml` runs this weekly next to the
DTEX sync and opens one pull request if either list changed. Nothing is
committed to `main` without review.
