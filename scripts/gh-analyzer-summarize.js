#!/usr/bin/env node
/**
 * gh-analyzer-summarize.js
 * ==========================================================================
 * Reads the report.json files gh-fake-analyzer wrote (one directory per login
 * under <outDir>) and merges a compact summary of each into
 * scripts/data/gh-analyzer.json, which the indicator pages render.
 *
 *   node scripts/gh-analyzer-summarize.js <outDir> <targets.txt> [version]
 *
 * A login in the targets file with no report is recorded as not analyzed
 * that day (the tool found no account, or failed) rather than dropped, so the
 * next run moves on instead of retrying it forever. Only signals are kept;
 * the full report stays in the workflow artifact. The account's own commit
 * addresses are kept so the page can say which of them this index already
 * holds; the others are listed for review, never turned into indicators here.
 * See docs/gh-fake-analyzer.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");

const [, , outDir, targetsFile, version = "unknown"] = process.argv;
if (!outDir || !targetsFile) {
  console.error("usage: gh-analyzer-summarize.js <outDir> <targets.txt> [version]");
  process.exit(2);
}
const DATA_FILE = path.join(__dirname, "data", "gh-analyzer.json");
const data = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
  : { accounts: {} };
const today = new Date().toISOString().slice(0, 10);

const indexed = new Set();
for (const r of require("../src/_data/iocIndex.js")().records) {
  const m = r.ioc_type === "github_profile" && String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)$/);
  if (m) indexed.add(m[1].toLowerCase());
}
const onlyIndexed = (logins) => [...new Set((logins || []).filter((l) => indexed.has(String(l).toLowerCase())))].sort();
const lower = (v) => String(v || "").toLowerCase();

function summarize(login, report) {
  const p = report.profile_info || {};
  const owner = ((report.unique_emails || [])[0] || {}).owner || [];
  const emails = [...new Set(owner.map((e) => lower(e.email)).filter((e) => e && !e.endsWith("@users.noreply.github.com")))].sort();
  const names = [...new Set(owner.map((e) => String(e.name || "").trim()).filter(Boolean))].sort();
  const rotation = report.identity_rotation || {};
  const dprk = report.dprk_naming || {};
  const copies = report.potential_copy || [];
  return {
    analyzed: today,
    tool: "gh-fake-analyzer " + version,
    login: p.login || login,
    created_at: p.created_at || null,
    public_repos: p.public_repos ?? null,
    followers: p.followers ?? null,
    following: p.following ?? null,
    original_repos: report.original_repos_count ?? null,
    forked_repos: report.forked_repos_count ?? null,
    // Repositories whose first commit is older than the account itself: the
    // history was written somewhere else and pushed here.
    backdated_repos: copies.length,
    backdated_examples: copies.slice(0, 5).map((c) => ({ repo: c.repo, first_commit: String(c.commit_date || "").slice(0, 10) })),
    // Commits in another owner's repository that are all also in one of this
    // account's own repositories.
    duplicate_commit_repos: (report.duplicate_hashes_found || []).length,
    commit_emails: emails,
    commit_names: names,
    names_per_email_max: Math.max(0, ...Object.values(rotation.multiple_names_per_email || {}).map((v) => v.count || 0)),
    emails_per_name_max: Math.max(0, ...Object.values(rotation.multiple_emails_per_name || {}).map((v) => v.count || 0)),
    dprk_naming: [...new Set([...(dprk.usernames || []), ...(dprk.email_names || [])])].sort(),
    following_indexed: onlyIndexed(report.following),
    followers_indexed: onlyIndexed(report.followers),
    mutual_indexed: onlyIndexed(report.mutual_followers),
    organizations: (report.organizations_member || []).slice().sort(),
  };
}

let done = 0, missing = 0;
for (const raw of fs.readFileSync(targetsFile, "utf8").split(/\r?\n/)) {
  const login = raw.trim();
  if (!login) continue;
  const file = path.join(outDir, login, "report.json");
  if (!fs.existsSync(file)) {
    data.accounts[login.toLowerCase()] = { analyzed: today, tool: "gh-fake-analyzer " + version, login, status: "no report" };
    missing += 1;
    continue;
  }
  data.accounts[login.toLowerCase()] = summarize(login, JSON.parse(fs.readFileSync(file, "utf8")));
  done += 1;
}
// Every target reading "no report" means gh-analyze itself failed (an outage,
// a bad token), not that every account is gone. Recording that would mark the
// whole batch analyzed and take it out of rotation, so nothing is written.
if (done === 0 && missing > 0) {
  console.error(`gh-analyze produced no reports for any of the ${missing} target(s); leaving the data file unchanged.`);
  process.exit(1);
}
data._comment =
  "gh-fake-analyzer (github.com/shortdoom/gh-fake-analyzer, by the Ketman Project) run over GitHub accounts in this " +
  "index by .github/workflows/gh-analyzer.yml, summarized by scripts/gh-analyzer-summarize.js. Signals only: an account " +
  "flagged here is not thereby attributed to anyone, and one that passes is not cleared. See docs/gh-fake-analyzer.md.";
data.updated = today;
data.accounts = Object.fromEntries(Object.entries(data.accounts).sort(([a], [b]) => a.localeCompare(b)));
writeFileAtomic(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
console.log(`summarized ${done}, no report ${missing}, total ${Object.keys(data.accounts).length}`);
