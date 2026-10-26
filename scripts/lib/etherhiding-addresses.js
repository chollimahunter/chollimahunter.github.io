"use strict";

/**
 * One row per watchlisted EtherHiding address (contract or wallet), carrying
 * every C2 host tied to it and when the address was last seen active. This is
 * what the address table on /etherhiding/ renders.
 *
 * A host is tied to an address four ways: the value a mapping contract serves
 * now, each value its setString history wrote (tied to the contract and to the
 * writing wallet), each IP a NullReceiver-style resolver wallet pointed at, and
 * any watchlisted domain or IP whose description or sources name the address,
 * and the hosts an address entry lists under c2_hosts because a cited report
 * ties them to it.
 * The first three come dated from the checker's latest run; c2_hosts carries
 * no date. A TRON or Aptos pointer may also carry c2_history: dated runs this
 * site read from the pointer's own writes and the BSC payloads they named,
 * which date the same ties. An address that is itself an encoded C2 (NullReceiver and XCTDH
 * write the IP into the recipient address) is tied to the IP it decodes to,
 * and an owner wallet with nothing of its own takes its contract's hosts.
 *
 * A dated tie carries the transaction that wrote the value, first and last,
 * as { chain, hash }, so a page can link the date to a block explorer. A
 * cross-chain pointer's tie takes the BSC payload transaction, which is where
 * the host itself is written.
 *
 * `review` is scripts/data/etherhiding-c2-review.json: hosts read on-chain
 * that were reviewed and found to be parked values, placeholders or ordinary
 * services. They are kept, under `decoys` with their verdict, so the tracker
 * can show and search them, but never count as C2 or as the latest C2. `indexed` maps every host the index already holds, from any source,
 * to its indicator page id. A host is `known` when the watchlist or the
 * index carries it; every other host read on-chain still needs filing.
 */

const ADDRESS_TYPES = new Set(["smart_contract_address", "wallet_address"]);
const HOST_TYPES = new Set(["domain", "ip_address", "hosted_site"]);
const PLACEHOLDER_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
// Changes that are not activity by the address itself.
const PASSIVE_CHANGES = new Set(["first observation"]);

function hostOf(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The IPv4 addresses an encoded recipient carries, or none. NullReceiver
 * repeats the four IP bytes at bytes 4-7. XCTDH writes a primary endpoint
 * (IP, then port) and a secondary one after it, both on port 80 or 443 in
 * every case reported or observed; requiring both ports keeps a random
 * address from decoding, about four times in four billion.
 */
const ENDPOINT_PORTS = new Set(["0050", "01bb"]);

function ipFromHex(hex) {
  return hex === "00000000" ? null : hex.match(/../g).map((b) => parseInt(b, 16)).join(".");
}

function decodedIps(address) {
  const hex = String(address || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) return [];
  const first = hex.slice(0, 8);
  if (hex.slice(8, 16) === first) return [ipFromHex(first)].filter(Boolean);
  if (!ENDPOINT_PORTS.has(hex.slice(8, 12)) || !ENDPOINT_PORTS.has(hex.slice(20, 24))) return [];
  return [...new Set([ipFromHex(first), ipFromHex(hex.slice(12, 20))])].filter(Boolean);
}

function later(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function earlier(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function addressRows(watchlist, findings, review, indexed) {
  const entries = watchlist || [];
  const reviewed = (review && review.hosts) || {};
  const indexedHosts = indexed || new Map();
  const latest = findings || {};
  const runDay = String(latest.ran_at || "").slice(0, 10) || null;

  const watchedHosts = new Map();
  const hostEntries = [];
  for (const entry of entries) {
    if (!HOST_TYPES.has(entry.ioc_type)) continue;
    const host = hostOf(entry.value);
    if (!host) continue;
    if (!watchedHosts.get(host)) watchedHosts.set(host, entry.indicator_id || null);
    hostEntries.push({ host, text: [entry.description || "", ...(entry.sources || []).map((s) => s.url || "")].join(" ").toLowerCase() });
  }

  const rows = new Map();
  for (const entry of entries) {
    if (!ADDRESS_TYPES.has(entry.ioc_type)) continue;
    const address = String(entry.value).toLowerCase();
    if (rows.has(address)) continue;
    rows.set(address, { entry, address, hosts: new Map(), lastActive: null });
  }

  function tie(address, value, first, last, firstTx = null, lastTx = firstTx) {
    const row = rows.get(String(address || "").toLowerCase());
    const host = hostOf(value);
    if (!row || !host || PLACEHOLDER_HOSTS.has(host)) return;
    const verdict = reviewed[host] ? reviewed[host].verdict || "parked" : null;
    const seen = row.hosts.get(host) || { host, first: null, last: null, first_tx: null, last_tx: null, known: verdict ? true : watchedHosts.has(host) || indexedHosts.has(host), indicator_id: verdict ? null : watchedHosts.get(host) || indexedHosts.get(host) || null, decoy: verdict };
    if (first && (!seen.first || first < seen.first || (first === seen.first && !seen.first_tx))) seen.first_tx = firstTx;
    if (last && (!seen.last || last > seen.last || (last === seen.last && !seen.last_tx))) seen.last_tx = lastTx;
    seen.first = earlier(seen.first, first);
    seen.last = later(seen.last, last);
    row.hosts.set(host, seen);
    row.lastActive = later(row.lastActive, last);
  }

  function active(address, day) {
    const row = rows.get(String(address || "").toLowerCase());
    if (row) row.lastActive = later(row.lastActive, day);
  }

  const txOn = (chain, hash) => (hash ? { chain: chain || null, hash } : null);

  for (const obs of latest.observations || []) {
    for (const write of obs.mapping_history || []) {
      const tx = txOn(obs.chain, write.tx);
      tie(obs.target, write.value, write.since, write.until, tx);
      if (write.from) tie(write.from, write.value, write.since, write.until, tx);
    }
    for (const current of obs.mapping || []) {
      const written = (obs.mapping_history || []).filter((w) => w.value === current.value && w.from === current.operator);
      const last = written.length ? written[written.length - 1] : null;
      const since = last ? last.since : null;
      const tx = txOn(obs.chain, last && last.tx);
      tie(obs.target, current.value, since, since, tx);
      tie(current.operator, current.value, since, since, tx);
    }
    for (const run of obs.rotation || []) {
      active(obs.target, run.until);
      const firstTx = txOn(obs.chain, run.first_tx);
      const lastTx = txOn(obs.chain, run.last_tx);
      for (const ip of run.resolved_ips || (run.resolved_ip ? [run.resolved_ip] : decodedIps(run.to))) {
        tie(obs.target, ip, run.from, run.until, firstTx, lastTx);
        tie(run.to, ip, run.from, run.until, firstTx, lastTx);
      }
    }
  }

  for (const change of latest.changes || []) {
    if (!PASSIVE_CHANGES.has(change.change)) active(change.target, runDay);
  }

  for (const row of rows.values()) {
    // A cross-chain pointer's hosts as this site dated them on-chain: each
    // pointer write, the BSC payload it named, and the hosts in that payload.
    for (const run of row.entry.c2_history || []) tie(row.address, run.host, run.since, run.until, txOn("bsc", run.payload_tx), null);
    for (const host of row.entry.c2_hosts || []) tie(row.address, host, null, null);
    for (const ip of decodedIps(row.address)) if (!row.hosts.has(ip)) tie(row.address, ip, null, null);
    for (const { host, text } of hostEntries) {
      if (row.hosts.has(host) || !text.includes(row.address)) continue;
      row.hosts.set(host, { host, first: null, last: null, first_tx: null, last_tx: null, known: true, indicator_id: watchedHosts.get(host) || indexedHosts.get(host) || null, decoy: null });
    }
  }

  for (const row of rows.values()) {
    if (row.entry.onchain_role !== "owner_eoa" || row.hosts.size) continue;
    const own = String(row.entry.description || "").toLowerCase();
    for (const other of rows.values()) {
      if (other === row || other.entry.ioc_type !== "smart_contract_address") continue;
      const names = own.includes(other.address) || own.includes(String(other.entry.id).toLowerCase()) ||
        String(other.entry.description || "").toLowerCase().includes(row.address);
      if (!names) continue;
      for (const [host, seen] of other.hosts) row.hosts.set(host, { ...seen });
    }
  }

  return [...rows.values()]
    .map(({ entry, address, hosts, lastActive }) => {
      const all = [...hosts.values()].sort(
        (a, b) => (b.first || "").localeCompare(a.first || "") || (b.last || "").localeCompare(a.last || "") || a.host.localeCompare(b.host)
      );
      const c2 = all.filter((h) => !h.decoy);
      const decoys = all.filter((h) => h.decoy);
      return {
        id: entry.id,
        value: address,
        ioc_type: entry.ioc_type,
        chain: entry.chain || null,
        role: entry.onchain_role || null,
        malware_family: entry.malware_family || null,
        confidence_level: entry.confidence_level,
        attribution_doubt: entry.attribution_doubt || null,
        indicator_id: entry.indicator_id || null,
        c2,
        decoys,
        latest_c2: c2[0] || null,
        last_active: lastActive,
      };
    })
    .sort(
      (a, b) =>
        ((b.latest_c2 && b.latest_c2.first) || "").localeCompare((a.latest_c2 && a.latest_c2.first) || "") ||
        (b.last_active || "").localeCompare(a.last_active || "") ||
        b.c2.length - a.c2.length ||
        a.value.localeCompare(b.value)
    );
}

/**
 * Both directions of every address-to-host tie, keyed by indicator page id,
 * for the "On-chain links" section of /indicators/{id}/: a host's page lists
 * the addresses that served it, an address's page the hosts it served. An
 * address page also lists a host read on-chain that has no page yet, marked
 * unreviewed, as the tracker does. `records` maps an indicator id to its index
 * record, for the network lookup each host row shows; `registrations` maps a
 * non-C2 host, which has no record, to its registration lookup.
 */
function onChainLinks(rows, records = new Map(), registrations = {}) {
  const links = {};
  const add = (id, item) => {
    if (!id) return;
    (links[id] = links[id] || []).push(item);
  };
  const networkOf = (id) => {
    const net = id && records.get(id) && records.get(id).network_status;
    return net ? { label: net.label, provider: net.provider || null, asn: net.asn || null, isp: net.isp || null, country: net.country_name || null } : null;
  };
  const registrationOf = (id) => (id && records.get(id) && records.get(id).registration) || null;
  for (const row of rows) {
    const kind = row.ioc_type === "smart_contract_address" ? "contract" : "wallet";
    for (const c of row.c2) {
      if (row.indicator_id) {
        add(c.indicator_id, { id: row.indicator_id, value: row.value, kind, chain: row.chain, role: row.role, malware_family: row.malware_family, first: c.first, last: c.last, first_tx: c.first_tx, last_tx: c.last_tx });
      }
      add(row.indicator_id, { id: c.indicator_id, value: c.host, known: c.known, network: networkOf(c.indicator_id), registration: registrationOf(c.indicator_id), first: c.first, last: c.last, first_tx: c.first_tx, last_tx: c.last_tx });
    }
    // Non-C2 values show on the address's own page, marked, and have no page of their own.
    for (const d of row.decoys || []) {
      add(row.indicator_id, { id: null, value: d.host, known: true, decoy: d.decoy, network: null, registration: registrations[d.host] || null, first: d.first, last: d.last, first_tx: d.first_tx, last_tx: d.last_tx });
    }
  }
  for (const list of Object.values(links)) {
    list.sort((a, b) => (b.first || "").localeCompare(a.first || "") || a.value.localeCompare(b.value));
  }
  return links;
}

module.exports = { addressRows, onChainLinks, hostOf, decodedIps };
