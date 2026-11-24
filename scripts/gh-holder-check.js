#!/usr/bin/env node
/**
 * gh-holder-check.js
 * ==========================================================================
 * Lists indexed addresses whose GitHub holder looks like an established real
 * developer: the possible false positives in the index. See
 * docs/gh-holder-check.md.
 *
 *   node scripts/gh-holder-check.js [--min N] [--refresh]
 *
 * Reads the email-owner pivot's results (_drafts/private/gh-email-owners.json)
 * without writing to them, so it can run while that sweep does. Each holder's
 * profile is fetched once through the core API and cached in
 * _drafts/private/gh-holder-profiles.json; --refresh fetches them again.
 * Addresses already withdrawn as false positives are left out. Prints the
 * holders scoring --min (default 3) or more, highest first, with the source
 * behind each address, because a value only a bulk list carries is the
 * likeliest to be wrong.
 */
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { privatePath, isFalsePositive } = require("./lib/private-data.js");
const { signals, score } = require("./lib/holder-check.js");

const OWNERS = privatePath("gh-email-owners.json");
const CACHE = privatePath("gh-holder-profiles.json");

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function profile(login) {
  const r = spawnSync("gh", ["api", `users/${login}`], { encoding: "utf8" });
  if (r.error) throw new Error(`gh unavailable: ${r.error.message}`);
  if (r.status !== 0) return { missing: true };
  const p = JSON.parse(r.stdout);
  return { login: p.login, id: p.id, created_at: p.created_at, followers: p.followers, public_repos: p.public_repos, company: p.company, blog: p.blog, name: p.name };
}

/** Which sources stand behind each indexed address: publishers, or the bulk dataset. */
function sourcesByAddress() {
  const out = new Map();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "email_address") continue;
    const pubs = [...new Set((r.sources || []).map((s) => s.publisher || s.researcher).filter(Boolean))];
    out.set(String(r.value).toLowerCase(), { id: r.id, publishers: pubs, campaign: [].concat(r.campaign || []) });
  }
  return out;
}

function main(args) {
  const mi = args.indexOf("--min");
  const min = mi >= 0 ? Number(args[mi + 1]) : 3;
  const refresh = args.includes("--refresh");
  const owners = readJson(OWNERS, null);
  if (!owners) {
    console.error(`no ${OWNERS}; run scripts/gh-email-owners.js collect first`);
    process.exit(1);
  }
  const cache = readJson(CACHE, { profiles: {} });
  const fp = isFalsePositive();
  const sources = sourcesByAddress();
  const rows = [];
  let fetched = 0;
  for (const [email, e] of Object.entries(owners.emails || {})) {
    if (fp(email)) continue;
    for (const [login, holding] of Object.entries(e.owners || {})) {
      const key = login.toLowerCase();
      if (refresh || !cache.profiles[key]) {
        cache.profiles[key] = { ...profile(login), fetched: new Date().toISOString().slice(0, 10) };
        if (++fetched % 25 === 0) writeFileAtomic(CACHE, JSON.stringify(cache, null, 1) + "\n");
      }
      const p = cache.profiles[key];
      const sig = signals(p.missing ? null : p, holding);
      const s = score(sig);
      if (s < min) continue;
      const src = sources.get(email);
      const bulk = (e.refs || []).filter((r) => r.dataset).map((r) => r.dataset);
      rows.push({ email, login, s, sig, publishers: src ? src.publishers : [], bulk, indexed: Boolean(src) });
    }
  }
  if (fetched) writeFileAtomic(CACHE, JSON.stringify(cache, null, 1) + "\n");
  rows.sort((a, b) => b.s - a.s || a.email.localeCompare(b.email));
  console.log(`${Object.keys(owners.emails || {}).length} address(es) read, ${fetched} profile(s) fetched; ${rows.length} holder(s) scoring ${min}+\n`);
  for (const r of rows) {
    const from = [...r.publishers, ...r.bulk.map((d) => `bulk:${d}`)].join("; ") || "(not in the index)";
    console.log(`${String(r.s).padStart(2)}  ${r.email.padEnd(38)} -> ${r.login.padEnd(22)} [${from}]\n      ${r.sig.join(", ")}`);
  }
}

main(process.argv.slice(2));
