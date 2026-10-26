# Tool: IP network-type lookups

## Purpose

An IP address in a report is four numbers. What makes it readable is the kind
of network behind it. A login from a subscriber line at a home broadband
provider in the city a CV claims is one thing; the same login from a hosting
range in another country, or from an exit Spur attributes to Astrill VPN, is
another, and the hiring red flags on `/remote-workers/` turn on exactly that
difference.

`scripts/data/ip-lookups.json` holds what was found for each IP indicator.
`src/_data/iocIndex.js` reads it at build time and attaches a `network_status`
block to the record; `src/_includes/partials/ioc-detail.njk` renders it under
"Network" wherever that indicator appears, and the search rows carry the kind
as a chip. Nothing is inferred: an address with no entry renders with no
network block at all, because "not looked up" and "unknown" are different
claims.

## What each address is classified as

`kind` is one of the following, applied in this order:

- **vpn**: the address is on Spur's published Astrill VPN list, the
  `spur-astrill-vpn-ips` dataset (see `docs/sync-spur-astrill-ips.md`).
  `provider` names the service. This is the only classification that names a
  VPN service, because the list is the only source that does.
- **proxy**: ip-api.com flags the range as a proxy or VPN, service unknown.
- **datacenter**: a hosting or cloud provider's range.
- **mobile**: a mobile carrier's range.
- **fixed-line**: none of the above, which is an internet service provider's
  subscriber range, the kind of line a person working from home has.
- **unresolved**: the service returned no answer, which is what a private,
  reserved or otherwise unrouted address gets. The reason is kept in `note`.

A range can be several of these at once. Most VPN exits are rented from
hosting providers, so an Astrill address is usually also a hosting range and
usually also flagged as a proxy; the three flags are kept beside `kind` so
that is visible. Beside them sit the announcing network (`isp`, `org`, `asn`)
and the country the range is registered to, which is where the range is, not
where any person was.

## Where the answers come from

The Astrill membership is the dataset. Everything else is
[ip-api.com](https://ip-api.com/)'s batch endpoint, which returns the
announcing network and its own hosting, proxy and mobile flags for 100
addresses a request, 15 requests a minute, free for non-commercial use over
plain HTTP. `scripts/enrich-ips.js` paces itself off the rate-limit headers
the service returns and writes the file in a stable order, so a rerun's diff
is the changed entries alone.

The classification is the service's. It is good at hosting ranges, which are
announced as such, and at the large VPN providers; it is weaker on small or
new proxy services and on residential proxy networks, which by design sit on
ordinary subscriber lines and look like fixed lines here. A `fixed-line`
answer therefore means "no anonymising service was recognised on this range",
not "a person's home connection".

## What the first pass found, 2026-09-21

5,296 IP indicators, all looked up:

| kind | addresses |
| --- | --- |
| Astrill VPN | 2,396 |
| data centre | 1,662 |
| fixed line | 826 |
| proxy or VPN, service unknown | 371 |
| mobile carrier | 41 |

Seven of Spur's 2,403 lines are .0 network addresses, which the index refuses as it refuses them from any report, so the dataset carries 2,396. 157 of those were already in the index from other reporting
before Spur's list was added, which is the corroboration one would expect: a
report naming an address a persona connected from, and Spur's list saying
which service the address belongs to.

## Running it

```
node scripts/enrich-ips.js            # addresses with no entry yet
node scripts/enrich-ips.js --refresh  # every address again
```

Run it after any change that adds IP indicators: a scrape run, a new dataset,
a dossier. It is not run from CI; the lookups land in the checked-in file and
the build does nothing but read them.
