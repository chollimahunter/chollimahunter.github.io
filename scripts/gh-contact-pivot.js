#!/usr/bin/env node
/**
 * gh-contact-pivot.js
 * ==========================================================================
 * Reads the contact details indexed GitHub accounts publish about themselves
 * and lists the ones the index does not hold yet.
 *
 * A persona's GitHub account often names its other channels: a Telegram
 * contact in the profile README, an X handle in the profile's own field, a
 * Discord or LinkedIn link among its social accounts, a mailbox in the bio. On
 * 22 November 2026 the README of greenfoxfun, an organisation already filed
 * under KGJ, named t.me/greenfoxfun, whose bio in turn named the X account
 * greenfoxworld. This script makes that read for every indexed account.
 *
 *   node scripts/gh-contact-pivot.js collect [--limit N] [--force]
 *   node scripts/gh-contact-pivot.js rank [--all]
 *
 * `collect` takes the index's live github_profile accounts and reads, through
 * GraphQL in batches of 25 (one request each, well inside the hourly budget),
 * each account's bio or description, public email, X username, website,
 * social accounts and profile README (the login/login repository for a user,
 * .github/profile/README.md for an organisation). Results go to
 * _drafts/private/gh-contact-pivot.json, rewritten after every batch.
 *
 * `rank` extracts platform accounts, LinkedIn profiles and email addresses
 * from what was read, normalizes them the way the index does, and prints each
 * value the index does not already carry, with the account it was read from
 * and the line it sits on. `--all` prints values already indexed too. Nothing
 * is filed automatically: a README may name a client, a template's author or
 * a project the account forked.
 */
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const norm = require("./lib/ioc-normalize.js");

const OUT = require("./lib/private-data.js").privatePath("gh-contact-pivot.json");
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const BATCH = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphql(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`gh unavailable: ${r.error.message}`);
    let body = null;
    try {
      body = JSON.parse(r.stdout || "null");
    } catch {
      body = null;
    }
    // A login that no longer resolves is a per-field NOT_FOUND error beside
    // the data for the others; only a missing data block is worth a retry.
    if (body && body.data) return body.data;
    const msg = String((r.stderr || "") + (r.stdout || "")).slice(0, 200);
    console.error(`  graphql failed (${msg.trim()}); retrying`);
    await sleep(20000);
  }
  return null;
}

const OWNER_FIELDS = `
  __typename login
  ... on User {
    name bio email company websiteUrl twitterUsername
    socialAccounts(first: 20) { nodes { provider url } }
  }
  ... on Organization {
    name description email websiteUrl twitterUsername
  }`;

function readmeField(alias, owner, repo, path) {
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
    md: object(expression: ${JSON.stringify(`HEAD:${path}`)}) { ... on Blob { text } }
    lower: object(expression: ${JSON.stringify(`HEAD:${path.replace("README.md", "readme.md")}`)}) { ... on Blob { text } }
  }`;
}

function indexedAccounts() {
  const live = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile") continue;
    if (r.account_status && r.account_status.state === "removed") continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/?$/);
    if (m && LOGIN.test(m[1])) live.add(m[1]);
  }
  return [...live];
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {} };
  let todo = indexedAccounts();
  if (!force) todo = todo.filter((h) => !data.accounts[h.toLowerCase()]);
  todo = todo.slice(0, limit);
  console.log(`${todo.length} account(s) to read`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const parts = [];
    batch.forEach((login, k) => {
      parts.push(`o${k}: repositoryOwner(login: ${JSON.stringify(login)}) { ${OWNER_FIELDS} }`);
      parts.push(readmeField(`u${k}`, login, login, "README.md"));
      parts.push(readmeField(`g${k}`, login, ".github", "profile/README.md"));
    });
    const res = await graphql(`query { ${parts.join("\n")} }`);
    if (!res) {
      console.error(`  batch at ${i} unread; stopping so a rerun resumes here`);
      break;
    }
    const today = new Date().toISOString().slice(0, 10);
    batch.forEach((login, k) => {
      const o = res[`o${k}`];
      const blob = (x) => (x && ((x.md && x.md.text) || (x.lower && x.lower.text))) || null;
      data.accounts[login.toLowerCase()] = {
        login,
        checked_at: today,
        found: !!o,
        current_login: o ? o.login : null,
        type: o ? o.__typename : null,
        name: o ? o.name || null : null,
        bio: o ? o.bio || o.description || null : null,
        email: o ? o.email || null : null,
        company: o ? o.company || null : null,
        website: o ? o.websiteUrl || null : null,
        twitter: o ? o.twitterUsername || null : null,
        social: o && o.socialAccounts ? o.socialAccounts.nodes.map((n) => ({ provider: n.provider, url: n.url })) : [],
        readme: blob(res[`u${k}`]) || blob(res[`g${k}`]),
      };
    });
    writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    await sleep(500);
  }
}

/** Every normalizable contact value in a piece of text, with its line. */
function extract(text) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const add = (ioc_type, value) => value && out.push({ ioc_type, value, line: line.trim().slice(0, 200) });
    for (const spec of norm.PLATFORM_ACCOUNTS) {
      const fn = norm.normalizePlatformAccount(spec);
      for (const m of line.match(norm.platformAccountPattern(spec)) || []) add(spec.ioc_type, fn(m));
    }
    for (const m of line.match(new RegExp(norm.LINKEDIN_PATTERN.source, "gi")) || []) add("linkedin_profile", norm.normalizeLinkedin(m));
    for (const m of line.match(norm.WHATSAPP_LINK_PATTERN) || []) add("phone_number", norm.normalizeWhatsappLink(m));
    for (const m of line.match(new RegExp(norm.EMAIL_PATTERN.source, "gi")) || []) {
      if (norm.isExcludedEmail && norm.isExcludedEmail(m)) continue;
      add("email", norm.normalizeEmail(m));
    }
  }
  return out;
}

function rank(args) {
  const all = args.includes("--all");
  const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const have = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) have.add(String(r.value).toLowerCase());
  let shown = 0;
  const rows = [];
  for (const a of Object.values(data.accounts)) {
    if (!a.found) continue;
    const vals = [];
    if (a.twitter) vals.push(...extract(`https://x.com/${a.twitter}`).map((v) => ({ ...v, line: `profile X field: ${a.twitter}`, where: "profile" })));
    for (const s of a.social || []) vals.push(...extract(s.url).map((v) => ({ ...v, line: `social account (${s.provider})`, where: "profile" })));
    for (const [where, text] of [["bio", a.bio], ["email field", a.email], ["website field", a.website], ["readme", a.readme]]) {
      vals.push(...extract(text).map((v) => ({ ...v, where })));
    }
    const seen = new Set();
    for (const v of vals) {
      const key = `${v.ioc_type} ${v.value}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (v.ioc_type === "github_profile") continue;
      const known = have.has(String(v.value).toLowerCase());
      if (known && !all) continue;
      rows.push(`${known ? "HAVE" : "NEW "} ${a.login.padEnd(24)} ${v.ioc_type.padEnd(18)} ${String(v.value).padEnd(48)} [${v.where}] ${v.line}`);
      shown++;
    }
  }
  rows.sort();
  console.log(rows.join("\n"));
  console.log(`${shown} value(s) from ${Object.values(data.accounts).filter((a) => a.found).length} account(s) read`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "rank") rank(rest);
else {
  console.error("usage: gh-contact-pivot.js collect [--limit N] [--force] | rank [--all]");
  process.exit(2);
}
