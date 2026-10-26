#!/usr/bin/env node
/**
 * check-indexing.js — ask Google whether the site's pages are indexed
 * ====================================================================
 * Calls the Search Console URL Inspection API for the hub pages and a
 * rotating sample of indicator pages, and reports each page's verdict,
 * coverage state ("Submitted and indexed", "Discovered - currently not
 * indexed", ...) and last crawl. Run daily by .github/workflows/check-indexing.yml.
 *
 * Credentials: a Google Cloud service account that has been added as a user
 * on the Search Console property. Its JSON key is read from the
 * GSC_SERVICE_ACCOUNT environment variable (a repository secret) and never
 * written to disk. No dependency: the OAuth token is minted from a signed JWT
 * with node's crypto.
 *
 * Usage: GSC_SERVICE_ACCOUNT="$(cat key.json)" node scripts/check-indexing.js [--sample N]
 * Writes a Markdown table to $GITHUB_STEP_SUMMARY when set, else to stdout.
 * Exits 0 without checking when the secret is not set, and 1 only when the
 * API cannot be reached or refuses the credentials.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");

const SITE = "https://chollimahunter.github.io/";
const HUBS = ["", "remote-workers/", "hunts/", "profiles/", "indicators/browse/", "sources/", "repo-scanner/"];
const sampleArg = process.argv.indexOf("--sample");
const SAMPLE = sampleArg > 0 ? Number(process.argv[sampleArg + 1]) : 40;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signature = b64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    signal: AbortSignal.timeout(30000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token request refused (HTTP ${res.status}): ${body.error_description || body.error || "no detail"}`);
  return body.access_token;
}

// A GET with a timeout that reports the status when the answer is not a 2xx.
async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

// Indicator page URLs from the live sitemaps, so the check needs no build.
async function indicatorUrls() {
  const index = await fetchText(SITE + "sitemap.xml");
  const maps = [...index.matchAll(/<loc>([^<]*sitemap-indicators-\d+\.xml)<\/loc>/g)].map((m) => m[1]);
  const urls = [];
  for (const map of maps) {
    const text = await fetchText(map);
    for (const m of text.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(m[1]);
  }
  return urls;
}

// The same sample all day, a different one tomorrow: step through the list
// by day number so every page comes round in turn.
function rotatingSample(urls, n) {
  if (!urls.length) return [];
  const day = Math.floor(Date.now() / 86400000);
  const start = (day * n) % urls.length;
  return Array.from({ length: Math.min(n, urls.length) }, (_, i) => urls[(start + i) % urls.length]);
}

async function inspect(token, url) {
  const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    signal: AbortSignal.timeout(30000),
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: SITE }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body.error && body.error.message) || String(res.status);
    if (res.status === 401 || res.status === 403) throw new Error(`inspection refused (${res.status}): ${message}`);
    return { url, verdict: "ERROR", coverage: message, crawled: "" };
  }
  const r = (body.inspectionResult && body.inspectionResult.indexStatusResult) || {};
  return { url, verdict: r.verdict || "", coverage: r.coverageState || "", crawled: (r.lastCrawlTime || "").slice(0, 10) };
}

async function main() {
  // Until the secret exists the scheduled run passes quietly rather than
  // failing every day.
  if (!process.env.GSC_SERVICE_ACCOUNT) {
    console.log("check-indexing: GSC_SERVICE_ACCOUNT is not set; nothing checked.");
    return;
  }
  const key = JSON.parse(process.env.GSC_SERVICE_ACCOUNT);
  const token = await accessToken(key);

  const hubs = HUBS.map((p) => SITE + p);
  const sample = rotatingSample(await indicatorUrls(), SAMPLE);
  const rows = [];
  for (const url of [...hubs, ...sample]) rows.push(await inspect(token, url));

  const tally = {};
  for (const r of rows) tally[r.coverage || "(none)"] = (tally[r.coverage || "(none)"] || 0) + 1;
  const indexed = (list) => list.filter((r) => r.verdict === "PASS").length;
  const hubRows = rows.slice(0, hubs.length);
  const sampleRows = rows.slice(hubs.length);

  const lines = [
    `## Google index status, ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Hub pages indexed: ${indexed(hubRows)} of ${hubRows.length}. Indicator pages indexed: ${indexed(sampleRows)} of ${sampleRows.length} sampled.`,
    "",
    "| Coverage state | Pages |",
    "| --- | --- |",
    ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "| Page | Verdict | Coverage | Last crawl |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.url.replace(SITE, "/")} | ${r.verdict} | ${r.coverage} | ${r.crawled} |`),
    "",
  ];
  const out = lines.join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
  console.log(out);
}

main().catch((err) => {
  console.error(`check-indexing: ${err.message}`);
  process.exit(1);
});
