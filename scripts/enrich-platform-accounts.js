#!/usr/bin/env node
/**
 * enrich-platform-accounts.js
 * ==============================================================
 * Checks whether each indexed account on a platform other than GitHub and
 * LinkedIn still exists, and writes the answers to
 * scripts/data/platform-account-status.json, which scripts/lib/platform-status.js
 * attaches to the records (the "Account status" a persona page shows).
 *
 *   node scripts/enrich-platform-accounts.js
 *
 * Only platforms that answer honestly are checked. A platform qualifies when a
 * made-up profile name gets a real "not found" (HTTP 404, an empty API result,
 * or for Telegram a page without the "Telegram: Contact" title) and a real
 * profile does not; probed on 28 September 2026. Fiverr, Medium and
 * CodeSandbox refuse automated requests, Trello, Freelancer.com, RemoteHub and
 * Calendly return the same page for a real and a made-up profile, and X needs
 * a login, so their accounts stay unchecked rather than being guessed at.
 *
 * One request at a time per platform, a second apart, with an honest user
 * agent. An answer that is neither clearly live nor clearly gone is recorded
 * as nothing, so the page keeps saying "not checked".
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const { safeDecode } = require("./lib/ioc-normalize.js");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Checks whether indexed platform accounts still exist; writes scripts/data/platform-account-status.json.");
  process.exit(0);
}

const OUT = path.join(__dirname, "data", "platform-account-status.json");
const UA = "ChollimaHunterScraper/1.0 (+https://chollimahunter.github.io/; account liveness check)";

const handleOf = (url) => safeDecode(String(url).replace(/\/+$/, "").split("/").pop()).replace(/^@/, "");

/** How each checkable platform is asked, and how its answer is read. */
const CHECKS = {
  telegram_account: {
    url: (v) => `https://t.me/${handleOf(v)}`,
    read: (res) => (res.status !== 200 ? null : /<title>Telegram: (Contact|View|Join)/i.test(res.body) ? "live" : "removed"),
  },
  gitlab_account: {
    url: (v) => `https://gitlab.com/api/v4/users?username=${encodeURIComponent(handleOf(v))}`,
    read: (res) => {
      if (res.status !== 200) return null;
      const list = JSON.parse(res.body);
      if (!list.length) return "removed";
      return list[0].state === "active" ? "live" : "removed";
    },
  },
  keybase_account: {
    url: (v) => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(handleOf(v))}`,
    read: (res) => {
      if (res.status !== 200) return null;
      const doc = JSON.parse(res.body);
      return doc.them && doc.them[0] ? "live" : "removed";
    },
  },
  dockerhub_account: {
    url: (v) => `https://hub.docker.com/v2/users/${encodeURIComponent(handleOf(v))}`,
    read: (res) => (res.status === 200 ? "live" : res.status === 404 ? "removed" : null),
  },
};
// Platforms that answer a missing profile with a real 404.
for (const type of [
  "huggingface_account",
  "freelancermap_account",
  "laborx_account",
  "xing_account",
  "torre_account",
  "himalayas_account",
  "linktree_account",
  "remoteok_account",
  "devto_account",
]) {
  CHECKS[type] = {
    url: (v) => (String(v).startsWith("http") ? String(v) : `https://${v}`),
    read: (res) => (res.status === 200 ? "live" : res.status === 404 || res.status === 410 ? "removed" : null),
  };
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: "", error: err.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const load = require("../src/_data/iocIndex.js");
  const index = await Promise.resolve(typeof load === "function" ? load() : load);
  const targets = index.records.filter((r) => CHECKS[r.ioc_type]);
  const today = new Date().toISOString().slice(0, 10);
  const accounts = [];
  const byType = {};
  for (const r of targets) (byType[r.ioc_type] = byType[r.ioc_type] || []).push(r.value);

  // Platforms in parallel, each one's accounts one at a time.
  await Promise.all(
    Object.entries(byType).map(async ([type, values]) => {
      for (const value of values) {
        const res = await fetchText(CHECKS[type].url(value));
        let state = null;
        try {
          state = CHECKS[type].read(res);
        } catch {
          state = null;
        }
        if (state) accounts.push({ type, value, state, checked: today });
        await sleep(1000);
      }
    })
  );
  accounts.sort((a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
  writeFileAtomic(
    OUT,
    JSON.stringify(
      {
        _comment:
          "Written by scripts/enrich-platform-accounts.js: whether each indexed account on a checkable platform still exists (live) or is gone (removed). Accounts the check could not answer are absent and read as not checked.",
        checked: today,
        accounts,
      },
      null,
      2
    ) + "\n"
  );
  const tally = {};
  for (const a of accounts) tally[a.type + " " + a.state] = (tally[a.type + " " + a.state] || 0) + 1;
  console.log(`checked ${targets.length} accounts, answered ${accounts.length}`);
  console.log(tally);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
