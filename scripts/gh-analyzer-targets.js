#!/usr/bin/env node
/**
 * gh-analyzer-targets.js
 * ==========================================================================
 * Picks the next batch of GitHub accounts for gh-fake-analyzer to analyze and
 * prints one login per line, for `gh-analyze --targets`.
 *
 *   node scripts/gh-analyzer-targets.js [count] > targets.txt
 *
 * Every github_profile in the index is eligible except an account already
 * recorded as removed in scripts/data/github-account-status.json. Accounts
 * never analyzed come first, then the one analyzed longest ago, so repeated
 * runs walk the whole index and then start refreshing it. Within each group an
 * account tied to a named persona comes before one in an unattributed group.
 * See docs/gh-fake-analyzer.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const count = Number(process.argv[2] || 20);
const DATA = path.join(__dirname, "data");
const read = (name, fallback) => {
  const file = path.join(DATA, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
};

const removed = new Set(
  (read("github-account-status.json", { accounts: [] }).accounts || [])
    .filter((a) => a.state === "removed")
    .map((a) => a.login.toLowerCase())
);
const analyzed = read("gh-analyzer.json", { accounts: {} }).accounts || {};

const seen = new Map();
for (const r of require("../src/_data/iocIndex.js")().records) {
  if (r.ioc_type !== "github_profile") continue;
  const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})$/);
  if (!m) continue;
  const login = m[1].toLowerCase();
  if (removed.has(login)) continue;
  const prior = seen.get(login);
  const persona = Boolean(r.persona_name);
  if (!prior || (persona && !prior.persona)) seen.set(login, { login, persona });
}

const rows = [...seen.values()].map((t) => ({
  ...t,
  last: (analyzed[t.login] && analyzed[t.login].analyzed) || "",
}));
rows.sort((a, b) => a.last.localeCompare(b.last) || (b.persona ? 1 : 0) - (a.persona ? 1 : 0) || a.login.localeCompare(b.login));
process.stdout.write(rows.slice(0, count).map((t) => t.login).join("\n") + "\n");
