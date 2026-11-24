/**
 * ct-pivot.js — pure helpers for scripts/ct-pivot.js.
 * No network: these take certificate records already fetched.
 *
 * Certificate-transparency logs record every publicly trusted certificate and
 * every name on it. An operator who puts two domains on one certificate, or
 * reuses one key pair across certificates, ties them together; a certificate
 * for a subdomain shows a host the reports never named. A certificate a
 * hosting platform issues for many unrelated customers ties nothing, so a
 * certificate naming more than a handful of registrable domains, or a known
 * shared host, is set aside.
 */
"use strict";

const lower = (v) => String(v || "").trim().toLowerCase().replace(/\.$/, "");

/** Hosts that mark a certificate a platform shares between customers. */
const SHARED_MARKERS = [/cloudflaressl\.com$/, /\.herokuapp\.com$/, /\.azurewebsites\.net$/, /\.netlify\.app$/, /\.vercel\.app$/, /\.github\.io$/, /\.pages\.dev$/, /\.wpengine\.com$/, /\.squarespace\.com$/, /\.wixsite\.com$/, /\.shopify\.com$/];
const MAX_REGISTRABLE = 6;

/** A certificate's names, without wildcards, deduplicated. */
function namesOf(cert) {
  return [...new Set((cert.names || []).map((n) => lower(n).replace(/^\*\./, "")).filter(Boolean))];
}

/** True when a certificate is a platform's shared certificate rather than one owner's. */
function isShared(names, registrable) {
  if (names.some((n) => SHARED_MARKERS.some((re) => re.test(n)))) return true;
  return new Set(names.map(registrable).filter(Boolean)).size > MAX_REGISTRABLE;
}

/**
 * Everything one seed domain's certificates say: subdomains of the seed,
 * other registrable domains on the same certificate, and the key hashes used.
 */
function readSeed(seed, certs, registrable) {
  const subdomains = new Map();
  const siblings = new Map();
  const keys = new Set();
  let shared = 0;
  for (const cert of certs || []) {
    const names = namesOf(cert);
    if (!names.length) continue;
    if (isShared(names, registrable)) {
      shared++;
      continue;
    }
    if (cert.pubkey) keys.add(cert.pubkey);
    for (const n of names) {
      const reg = registrable(n);
      if (!reg) continue;
      const when = String(cert.not_before || "").slice(0, 10);
      if (reg === seed) {
        if (n === seed) continue;
        const s = subdomains.get(n) || { first: when, last: when };
        if (when && (!s.first || when < s.first)) s.first = when;
        if (when && (!s.last || when > s.last)) s.last = when;
        subdomains.set(n, s);
      } else {
        const s = siblings.get(reg) || { domain: reg, names: new Set(), first: when, last: when };
        s.names.add(n);
        if (when && (!s.first || when < s.first)) s.first = when;
        if (when && (!s.last || when > s.last)) s.last = when;
        siblings.set(reg, s);
      }
    }
  }
  return {
    subdomains: [...subdomains].map(([host, s]) => ({ host, ...s })),
    siblings: [...siblings.values()].map((s) => ({ ...s, names: [...s.names] })),
    keys: [...keys],
    shared,
  };
}

/**
 * Leads across all seeds, against what the index holds (`indexed`: lower-cased
 * hosts). A sibling domain is the strong lead; a key shared by two seeds ties
 * two indexed domains together; a subdomain is a host nobody listed.
 */
function leads(seeds, indexed, registered = {}) {
  const siblings = new Map();
  const byKey = new Map();
  const subdomains = [];
  // A certificate older than the seed's current registration belongs to an
  // earlier owner of the name, and ties nothing to the operator.
  const current = (seed, s) => !registered[seed] || !s.last || s.last >= registered[seed];
  for (const [seed, r] of Object.entries(seeds)) {
    if (!r || r.error) continue;
    for (const s of r.siblings || []) {
      if (indexed.has(s.domain) || !current(seed, s)) continue;
      const g = siblings.get(s.domain) || { domain: s.domain, seeds: new Set(), names: new Set(), first: s.first };
      g.seeds.add(seed);
      for (const n of s.names) g.names.add(n);
      siblings.set(s.domain, g);
    }
    for (const k of r.keys || []) byKey.set(k, (byKey.get(k) || new Set()).add(seed));
    for (const sd of r.subdomains || []) if (!indexed.has(sd.host) && current(seed, sd)) subdomains.push({ ...sd, seed });
  }
  return {
    siblings: [...siblings.values()].map((g) => ({ ...g, seeds: [...g.seeds], names: [...g.names] })).sort((a, b) => b.seeds.length - a.seeds.length || a.domain.localeCompare(b.domain)),
    sharedKeys: [...byKey].filter(([, s]) => s.size > 1).map(([key, s]) => ({ key, seeds: [...s].sort() })),
    subdomains: subdomains.sort((a, b) => a.seed.localeCompare(b.seed) || a.host.localeCompare(b.host)),
  };
}

module.exports = { namesOf, isShared, readSeed, leads };
