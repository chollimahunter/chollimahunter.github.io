---
layout: base.njk
title: "EtherHiding Tracker"
description: "Every reported EtherHiding contract and wallet that serves malware or its C2 hosts, DPRK-linked or not, with their C2 history and this site's contract-checking tool."
extra_head: '<script src="/assets/js/table-filter.js" defer></script>'
---
{#
  src/etherhiding/index.md — EtherHiding Tracker page

  The tables come first and the explainer after them, so the search is the
  first thing a reader reaches. Keep each explainer section to one short
  paragraph; detail belongs in the cited sources.

  The watchlist lives in src/_data/iocs/etherhiding-watchlist.json (shape in
  CONTENT_GUIDE.md). The address table is built by
  scripts/lib/etherhiding-addresses.js from that file and the checker's
  latest run; this page doesn't change when either grows. C2 hosts are
  operator infrastructure and render as text, never as links.
#}

<section class="hero">

# EtherHiding Tracker

Contracts and wallets that serve malware or its C2 hosts.

</section>

<section>
{% set tableFilter = { target: "#address-table", noun: "addresses", page: limits.list, id: "address-search-input", label: "Search addresses", placeholder: "Address, C2 host, parked value, malware family, or chain", chips: [
  { dimension: "family", label: "Filter addresses by malware family", allLabel: "All families", counts: etherhidingAddresses.facets.family, short: "Family", multiple: true },
  { dimension: "chain", label: "Filter addresses by chain", allLabel: "All chains", counts: etherhidingAddresses.facets.chain, short: "Chain", multiple: true }
] } %}{% include "partials/table-filter.njk" %}
<div class="table-scroll">
<table class="results-table" id="address-table">
<thead>
<tr><th scope="col">Address</th><th scope="col">Kind</th><th scope="col">Family</th><th scope="col">C2 hosts</th><th scope="col">Non-C2 values</th><th scope="col">Latest C2</th><th scope="col">C2 added</th></tr>
</thead>
<tbody>
{% for row in etherhidingAddresses.rows %}
<tr data-family="{{ row.family_label }}" data-chain="{{ row.chain_label }}">
<td>{% if row.indicator_id %}<a href="/indicators/{{ row.indicator_id }}/"><code>{{ row.value }}</code></a>{% else %}<code>{{ row.value }}</code>{% endif %}{% if row.attribution_doubt %} <span class="badge badge--low">DPRK link unconfirmed</span>{% endif %}</td>
<td>{{ "Contract" if row.ioc_type == "smart_contract_address" else "Wallet" }}{% if row.chain %}, {{ row.chain }}{% endif %}</td>
<td>{{ row.malware_family or "" }}</td>
<td>{% if row.c2.length and row.indicator_id %}<a href="/indicators/{{ row.indicator_id }}/#on-chain-links">{{ row.c2.length }}</a>{% elif row.c2.length %}{{ row.c2.length }}{% endif %}</td>
<td>{% if row.decoys.length %}<span data-result-optional="non-C2 values">{% if row.indicator_id %}<a href="/indicators/{{ row.indicator_id }}/#on-chain-links">{{ row.decoys.length }}</a>{% else %}{{ row.decoys.length }}{% endif %}<span class="visually-hidden">{% for d in row.decoys %} {{ d.host }} {{ d.decoy }}{% endfor %}</span></span>{% endif %}</td>
<td>{% if row.latest_c2 %}{% set txLink = { text: row.latest_c2.host, tx: row.latest_c2.first_tx, code: true } %}{% include "partials/tx-link.njk" %}{% if not row.latest_c2.known %} <span class="badge badge--low">unreviewed</span>{% endif %}{% if row.c2.length > 1 %}<span class="visually-hidden">{% for c in row.c2 %}{% if not loop.first %} {{ c.host }}{% endif %}{% endfor %}</span>{% endif %}{% endif %}</td>
<td class="cell-date"{% if row.latest_c2 and not row.latest_c2.first %} data-sort-empty{% endif %}>{% if row.latest_c2 and row.latest_c2.first %}{{ row.latest_c2.first }}{% elif row.latest_c2 %}<span class="ioc-result__meta">reported</span>{% endif %}</td>
</tr>
{% endfor %}
</tbody>
</table>
</div>
{% include "partials/table-filter-more.njk" %}
<p class="form-hint">
Newest C2 first; an address's page lists every host it served. A C2 date is
when the host was written on-chain, and the host links to that transaction; "reported"
marks a tie a cited report states without one. Non-C2 values are what
the operator wrote that is not C2: a parked value is a well-known domain the
resolver points at between sessions, while each real host stays minutes to
hours. They are not indicators, and a download leaves them out unless asked.
A host read on-chain since the last review is marked unreviewed
until it is checked. "DPRK link unconfirmed" marks an address whose cited
reporting does not tie it to North Korea; it may belong to another actor, and its page says why.
</p>
</section>

<section>
<h2 id="watchlist">Other watchlist indicators</h2>
{% set tableFilter = { target: "#watchlist-table", noun: "indicators", page: limits.list, id: "watchlist-search-input", label: "Search EtherHiding indicators", placeholder: "Host, hash, indicator type, or publisher" } %}{% include "partials/table-filter.njk" %}
<div class="table-scroll">
<table class="results-table" id="watchlist-table">
<thead>
<tr><th scope="col">ID</th><th scope="col">Type</th><th scope="col">Value</th><th scope="col">Confidence</th><th scope="col">Source</th></tr>
</thead>
<tbody>
{% for entry in iocIndex.etherhiding.watchlist %}{% if entry.ioc_type not in ["smart_contract_address", "wallet_address"] %}
<tr>
<td><code>{{ entry.id }}</code></td>
<td>{{ entry.ioc_type | replace("_", " ") }}</td>
<td>{% if entry.indicator_id %}<a href="/indicators/{{ entry.indicator_id }}/"><code>{{ entry.value }}</code></a>{% else %}<code>{{ entry.value }}</code>{% endif %}{% if entry.attribution_doubt %} <span class="badge badge--low">DPRK link unconfirmed</span>{% endif %}</td>
<td><span class="badge badge--{{ entry.confidence_level }}">{{ entry.confidence_level }}</span></td>
<td>{% for s in entry.sources %}{% set externalLink = { url: s.url, text: s.publisher, sameTab: true } %}{% include "partials/external-link.njk" %}{% if not loop.last %}, {% endif %}{% endfor %}</td>
</tr>
{% endif %}{% endfor %}
</tbody>
</table>
</div>
{% include "partials/table-filter-more.njk" %}
<p class="form-hint">
The contracts and wallets are in the address table above. These are on-chain infrastructure, so the <a href="/remote-workers/">Remote
Workers</a> search does not reach them.
</p>
</section>

<section>

<h2 id="how-it-works">How EtherHiding works</h2>

A compromised page, trojanized package or fake coding assessment reads its next
stage from a smart contract with a read-only `eth_call`. Removing the site or
package leaves the contract in place, a new payload costs only a transaction
fee, and the contract's history shows the writes but not the reads that
delivered the payload.

</section>

<section>

<h2 id="attribution">Attribution</h2>

In October 2025 Google's Threat Intelligence Group reported the DPRK-linked
actor **UNC5342** using EtherHiding since about February 2025 in **Contagious
Interview**, delivering **JADESNOW**, **BEAVERTAIL** and **INVISIBLEFERRET**
([source 1](#source-1)); see the [DPRK Repo Scanner](/repo-scanner/).
**UNC5142** uses the method for crimeware without state attribution and is not
listed ([source 2](#source-2)).

</section>

<section>

<h2 id="storage-shapes">Where the payload or C2 sits</h2>

- **Contract state:** the payload or a C2 URL sits in contract storage and is
  read back by a view method. EtherRAT's resolver contracts hold one C2 URL per
  operator wallet.
- **Transaction calldata:** GTIG lists transactions sent to the burn address
  carrying INVISIBLEFERRET payload; this site's enumeration of the sending
  wallet found ten, not three.
- **No payload at all:** NullReceiver ([source 3](#source-3)) decodes its C2 IP
  from the recipient of a resolver wallet's latest zero-value transaction, so
  the address rotates; most of the resulting IPs appear in no published
  reporting.

</section>

<section>

<h2 id="checker-tool">The checker tool</h2>

The checker matches addresses against the watchlist and, given an RPC endpoint,
reads each contract's data and C2 history without executing anything. A scheduled
workflow opens a pull request when anything moves; output is on the
[results page](/etherhiding/results/).

</section>

{% set disclaimer = { title: "Sourcing and review", body: "Mechanism and attribution claims come from the cited reporting, not independent analysis by this site. A watchlist match is a starting point for review, not a finding that a contract is malicious." } %}{% include "partials/disclaimer.njk" %}

<section>

## Sources

1. <span id="source-1"></span>Blas Kojusner, Robert Wallace, Joseph Dobson, "DPRK Adopts EtherHiding: Nation-State Malware Hiding on Blockchains," Mandiant / Google Threat Intelligence Group, October 16, 2025. {% set externalLink = { url: "https://cloud.google.com/blog/topics/threat-intelligence/dprk-adopts-etherhiding", text: "cloud.google.com/blog/topics/threat-intelligence/dprk-adopts-etherhiding" } %}{% include "partials/external-link.njk" %}
2. <span id="source-2"></span>"New Group on the Block: UNC5142 Leverages EtherHiding to Distribute Malware," Google Cloud Blog (Mandiant Threat Defense / GTIG), October 16, 2025. Cited only to scope UNC5142 out of the attribution above. {% set externalLink = { url: "https://cloud.google.com/blog/topics/threat-intelligence/unc5142-etherhiding-distribute-malware", text: "cloud.google.com/blog/topics/threat-intelligence/unc5142-etherhiding-distribute-malware" } %}{% include "partials/external-link.njk" %}
3. <span id="source-3"></span>Paul McCarty, "NullReceiver's Blank Crypto Transfers Solves the Challenges of EtherHiding," OpenSourceMalware, August 2, 2026. Cited for the NullReceiver wallet, encoded destination and decoded C2 IP. {% set externalLink = { url: "https://opensourcemalware.com/blog/nullreceiver-dprk-c2-technique", text: "opensourcemalware.com/blog/nullreceiver-dprk-c2-technique" } %}{% include "partials/external-link.njk" %}
4. <span id="source-4"></span>"Simulating EtherHiding: Blockchain as a Malware," Cymulate. Cited for the `eth_call` retrieval mechanics, not for attribution. {% set externalLink = { url: "https://cymulate.com/blog/simulating-etherhiding-blockchain-as-a-malware/", text: "cymulate.com/blog/simulating-etherhiding-blockchain-as-a-malware" } %}{% include "partials/external-link.njk" %}

</section>
