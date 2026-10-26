#!/usr/bin/env node
/**
 * enrich-osv-malicious.js
 * ==============================================================
 * Cross-checks the index's npm and PyPI package indicators against OSV's
 * malicious-package advisories (the MAL- ids the OpenSSF malicious-packages
 * project publishes into OSV), and writes the answers to
 * scripts/data/osv-malicious.json, which scripts/lib/osv-malicious.js attaches
 * to the records. The indicator page lists each advisory id with its date,
 * linked to osv.dev. No token is needed.
 *
 *   node scripts/enrich-osv-malicious.js
 *
 * Each package is looked up by name (a pinned version is ignored, since an
 * advisory may name other versions of the same package) with a batched
 * POST to https://api.osv.dev/v1/querybatch; every MAL- id that comes back is
 * then read from https://api.osv.dev/v1/vulns/{id} for its published and
 * modified dates and its summary. Packages OSV holds no MAL- advisory for are
 * recorded too (checked, no advisory), so a package that is in this index
 * but unreported upstream can be listed. A failed lookup is left out of the
 * file rather than recorded as "none".
 */
"use strict";

const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Cross-checks indexed npm and PyPI packages against OSV MAL- advisories; writes scripts/data/osv-malicious.json.");
  process.exit(0);
}

const OUT = path.join(__dirname, "data", "osv-malicious.json");
const API = "https://api.osv.dev/v1";
const UA = "ChollimaHunterScraper/1.0 (+https://chollimahunter.github.io/; OSV malicious-package cross-check)";
const ECOSYSTEM = { npm_package: "npm", pypi_package: "PyPI" };
const BATCH = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function osv(method, url, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "User-Agent": UA, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 200) return await res.json();
      if (res.status === 404) return null;
    } catch {
      /* retry */
    }
    await sleep(2000 * (attempt + 1));
  }
  return undefined;
}

// "@scope/name@1.2.3" or "name@1.2.3" or a bare name.
function packageName(value) {
  const m = /^(@?[^@]+)(?:@(.+))?$/.exec(String(value));
  return m ? m[1] : String(value);
}

// Every vulnerability id OSV holds for one package, following pagination.
async function idsFor(query, first) {
  const ids = (first.vulns || []).map((v) => v.id);
  let token = first.next_page_token;
  while (token) {
    const page = await osv("POST", `${API}/query`, { ...query, page_token: token });
    if (!page) return undefined;
    for (const v of page.vulns || []) ids.push(v.id);
    token = page.next_page_token;
    await sleep(200);
  }
  return ids;
}

async function main() {
  const load = require("../src/_data/iocIndex.js");
  const index = await Promise.resolve(typeof load === "function" ? load() : load);
  const targets = new Map();
  for (const r of index.records) {
    const ecosystem = ECOSYSTEM[r.ioc_type];
    if (!ecosystem) continue;
    const name = packageName(r.value);
    targets.set(`${r.ioc_type}|${name.toLowerCase()}`, { type: r.ioc_type, ecosystem, name });
  }
  const list = [...targets.values()];
  const today = new Date().toISOString().slice(0, 10);
  const advisories = new Map();
  const items = [];

  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    const queries = slice.map((t) => ({ package: { name: t.name, ecosystem: t.ecosystem } }));
    const answer = await osv("POST", `${API}/querybatch`, { queries });
    if (!answer || !Array.isArray(answer.results) || answer.results.length !== slice.length) {
      console.error(`batch starting at ${i} failed; its packages are left out`);
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const t = slice[j];
      const ids = await idsFor(queries[j], answer.results[j]);
      if (!ids) continue;
      const mal = ids.filter((id) => id.startsWith("MAL-"));
      const found = [];
      for (const id of mal) {
        if (!advisories.has(id)) {
          const v = await osv("GET", `${API}/vulns/${encodeURIComponent(id)}`);
          await sleep(100);
          advisories.set(id, v ? { id, published: (v.published || "").slice(0, 10), modified: (v.modified || "").slice(0, 10), summary: v.summary || "" } : null);
        }
        if (advisories.get(id)) found.push(advisories.get(id));
      }
      items.push({ type: t.type, name: t.name, advisories: found.sort((a, b) => a.id.localeCompare(b.id)) });
    }
    await sleep(500);
  }

  items.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  writeFileAtomic(
    OUT,
    JSON.stringify(
      {
        _comment:
          "Written by scripts/enrich-osv-malicious.js: the OSV malicious-package advisories (MAL- ids) held for each indexed npm and PyPI package, looked up by name. An empty advisories list means OSV held none when checked. Packages the lookup could not answer are absent.",
        checked: today,
        items,
      },
      null,
      2
    ) + "\n"
  );
  const withAdvisory = items.filter((x) => x.advisories.length).length;
  console.log(`checked ${list.length}, answered ${items.length}, with a MAL- advisory ${withAdvisory}, without ${items.length - withAdvisory}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
