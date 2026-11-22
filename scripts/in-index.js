#!/usr/bin/env node
/**
 * in-index.js
 * ==========================================================================
 * Says whether values are already in the index, comparing them the way the
 * index stores them.
 *
 *   node scripts/in-index.js <value> [<value> ...]
 *   node scripts/in-index.js --file values.txt     (one value per line)
 *
 * Each value is normalized with the shared normalizers before the lookup:
 * Gmail addresses folded (dots and +tags dropped), GitHub and LinkedIn URLs
 * canonicalized, a bare handle tried as a GitHub account, platform account
 * URLs rewritten to their canonical host, wallets cased by chain. Comparing
 * raw strings instead reported every dotted Gmail address in an X article as
 * missing when the index already held it (22 November 2026), which is what
 * this exists to prevent.
 *
 * Prints HAVE (with the record's sources and persona) or NEW per value, and
 * exits 0 either way: it reports, it does not decide.
 */
"use strict";

const fs = require("fs");
const norm = require("./lib/ioc-normalize.js");

function candidates(raw) {
  const v = String(raw).trim();
  const out = new Set([v.toLowerCase()]);
  const add = (x) => x && out.add(String(x).toLowerCase());
  if (v.includes("@") && !v.includes("/")) add(norm.normalizeEmail(v));
  if (/github\.com\//i.test(v)) add(norm.normalizeGithub(v));
  if (/linkedin\.com\//i.test(v)) add(norm.normalizeLinkedin(v.replace(/\/?$/, "/")));
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v)) {
    add(`https://github.com/${v}`);
    add(v);
  }
  for (const spec of norm.PLATFORM_ACCOUNTS) {
    if (spec.hosts.some((h) => v.toLowerCase().includes(h))) add(norm.normalizePlatformAccount(spec)(v));
  }
  if (/^(wa\.me|https?:\/\/(wa\.me|api\.whatsapp))/i.test(v)) add(norm.normalizeWhatsappLink(v));
  if (/^\+?\d[\d\s().-]{6,}$/.test(v)) add(norm.normalizePhone(v));
  if (norm.walletChain && norm.walletChain(v)) add(norm.normalizeWallet(v));
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) add(norm.normalizeDomain(v));
  return [...out];
}

function main() {
  const args = process.argv.slice(2);
  let values = args;
  const fi = args.indexOf("--file");
  if (fi >= 0) values = fs.readFileSync(args[fi + 1], "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!values.length) {
    console.error("usage: node scripts/in-index.js <value> [...] | --file <path>");
    process.exit(2);
  }
  const byValue = new Map();
  for (const r of require("../src/_data/iocIndex.js")().records) byValue.set(String(r.value).toLowerCase(), r);
  let have = 0;
  for (const v of values) {
    const hit = candidates(v).map((c) => byValue.get(c)).find(Boolean);
    if (!hit) {
      console.log(`NEW   ${v}`);
      continue;
    }
    have++;
    const pubs = [...new Set((hit.sources || []).map((s) => s.publisher))].slice(0, 3).join("; ");
    console.log(`HAVE  ${v}  -> ${hit.value} [${hit.ioc_type}] ${pubs}${hit.persona ? ` persona=${hit.persona.name}` : ""}`);
  }
  console.error(`${have} of ${values.length} already in the index`);
}

main();
