#!/usr/bin/env node
/**
 * gh-follow-graph.js
 * ==========================================================================
 * Finds GitHub accounts the index does not hold that sit inside the follow
 * network of the accounts it does. DPRK IT-worker personas follow one another
 * in tight clusters, and an account several known operators follow, or that
 * follows several of them back, is a lead worth a person's time; mutually
 * connected followers are one of the signals Nisos and NK Internet describe.
 *
 *   node scripts/gh-follow-graph.js collect [--limit N] [--force]
 *   node scripts/gh-follow-graph.js rank [--min N] [--top N]
 *
 * `collect` reads the followers and following lists of each seed account into
 * _drafts/private/gh-follow-graph.json, rewritten after every account, so an
 * interrupted run resumes where it stopped. Seeds are the index's live
 * github_profile accounts, except those tagged PolinRider (owners of affected
 * repositories, not operators) and those carrying attribution_doubt: a victim
 * seed would pull in ordinary developers.
 *
 * `rank` counts, for every account outside the index, how many distinct seeds
 * it is connected to and how many of those links run both ways, keeps those
 * connected to at least --min seeds (default 2), reads the profile of the top
 * --top (default 600) and writes _drafts/private/gh-follow-graph-leads.json.
 *
 * Every lead is a signal, never a finding: developers follow each other, and
 * follow-for-follow rings and popular accounts connect to everyone. Nothing
 * here reaches a published page; a lead is filed only on its own evidence.
 * Authentication is `gh api`, which never exposes a token. See
 * docs/gh-follow-graph.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const idp = require("./lib/identity-pivot.js");
const { privatePath } = require("./lib/private-data.js");

const GRAPH = privatePath("gh-follow-graph.json");
const LEADS = privatePath("gh-follow-graph-leads.json");
const STATUS = path.join(__dirname, "data", "github-account-status.json");
// Ten pages of 100. A seed past that is not a typical persona, and reading
// every follower of a popular account adds noise, not leads.
const MAX_PAGES = 10;
// An account this many people follow is somebody everyone follows.
const POPULAR = 1000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// gh-fake-analyzer's dprk_naming shape: a word followed by four digits.
const DPRK_NAMING = /^[a-z]+[-_.]?\d{4}$/i;
// A job word beside digits (TopRatedDev36428, challengedev210), the handle
// shape docs/github-account-similarity.md found lifted over its control.
const JOB_WORD_DIGITS = /(dev|developer|engineer|coder|soft|senior|talent|expert|master|guru|ninja|star|top|pro|wizard|tech|code)[-_.]?\d{2,}|\d{2,}[-_.]?(dev|developer|engineer|coder|soft|senior|talent|expert|master|guru|ninja|star|top|pro|wizard|tech|code)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One `gh api` call; waits out 403/429. Returns { status, json }. */
async function ghGet(endpoint) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync("gh", ["api", "--include", endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`gh unavailable: ${r.error.message}`);
    const res = idp.parseInclude(r.stdout || "");
    if (res.status >= 200 && res.status < 300) {
      try {
        return { status: res.status, json: JSON.parse(res.body) };
      } catch {
        return { status: res.status, json: null };
      }
    }
    if (res.status === 403 || res.status === 429) {
      const secs = idp.backoffSeconds(res.headers);
      console.error(`  ${res.status} on ${endpoint.split("?")[0]}; waiting ${secs}s`);
      await sleep(secs * 1000);
      continue;
    }
    return { status: res.status, json: null };
  }
  return { status: 0, json: null };
}

/** Every login on a followers or following list, up to MAX_PAGES pages. */
async function listLogins(login, which) {
  const logins = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, json } = await ghGet(`users/${login}/${which}?per_page=100&page=${page}`);
    if (status === 404) return { logins, missing: true, truncated: false };
    if (!Array.isArray(json)) break;
    for (const u of json) if (u && u.login) logins.push(u.login.toLowerCase());
    if (json.length < 100) return { logins, missing: false, truncated: false };
  }
  return { logins, missing: false, truncated: logins.length >= MAX_PAGES * 100 };
}

function indexAccounts() {
  const removed = new Set(
    ((fs.existsSync(STATUS) && JSON.parse(fs.readFileSync(STATUS, "utf8")).accounts) || [])
      .filter((a) => a.state === "removed")
      .map((a) => a.login.toLowerCase())
  );
  const all = new Map(); // login -> { seed, campaigns, persona }
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile") continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/?$/);
    if (!m || !LOGIN.test(m[1])) continue;
    const login = m[1].toLowerCase();
    const campaigns = r.campaign || [];
    const seed = !removed.has(login) && !campaigns.includes("PolinRider") && !r.attribution_doubt;
    const prior = all.get(login);
    all.set(login, {
      // A login filed twice is a seed only if no record of it disqualifies it.
      seed: prior ? prior.seed && seed : seed,
      campaigns: [...new Set([...(prior ? prior.campaigns : []), ...campaigns])],
      persona: (prior && prior.persona) || r.persona_name || null,
    });
  }
  return all;
}

function readGraph() {
  return fs.existsSync(GRAPH) ? JSON.parse(fs.readFileSync(GRAPH, "utf8")) : { accounts: {} };
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const graph = readGraph();
  let seeds = [...indexAccounts()].filter(([, a]) => a.seed).map(([login]) => login);
  if (!force) seeds = seeds.filter((l) => !graph.accounts[l]);
  seeds = seeds.slice(0, limit);
  console.log(`${seeds.length} seed account(s) to read`);
  let done = 0;
  for (const login of seeds) {
    const following = await listLogins(login, "following");
    const followers = following.missing ? { logins: [], truncated: false } : await listLogins(login, "followers");
    graph.accounts[login] = {
      missing: following.missing || undefined,
      following: following.logins,
      followers: followers.logins,
      truncated: following.truncated || followers.truncated || undefined,
      checked_at: new Date().toISOString().slice(0, 10),
    };
    writeFileAtomic(GRAPH, JSON.stringify(graph, null, 1) + "\n");
    done++;
    if (done % 25 === 0 || done === seeds.length) console.log(`  ${done}/${seeds.length} read`);
  }
}

async function rank(args) {
  const num = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 ? Number(args[i + 1]) : fallback;
  };
  const min = num("--min", 2);
  const top = num("--top", 600);
  const index = indexAccounts();
  const graph = readGraph();

  const candidates = new Map(); // login -> { followed_by: Set, follows: Set }
  const touch = (login) => {
    if (!candidates.has(login)) candidates.set(login, { followed_by: new Set(), follows: new Set() });
    return candidates.get(login);
  };
  for (const [seed, g] of Object.entries(graph.accounts)) {
    if (!index.get(seed) || !index.get(seed).seed) continue; // a seed since disqualified
    for (const l of g.following || []) if (!index.has(l)) touch(l).followed_by.add(seed);
    for (const l of g.followers || []) if (!index.has(l)) touch(l).follows.add(seed);
  }

  let rows = [];
  for (const [login, c] of candidates) {
    const seeds = new Set([...c.followed_by, ...c.follows]);
    if (seeds.size < min) continue;
    const mutual = [...c.followed_by].filter((s) => c.follows.has(s));
    rows.push({
      login,
      seeds: seeds.size,
      mutual: mutual.length,
      score: seeds.size + mutual.length,
      followed_by: [...c.followed_by].sort(),
      follows: [...c.follows].sort(),
      personas: [...new Set([...seeds].map((s) => index.get(s).persona).filter(Boolean))].sort(),
      campaigns: [...new Set([...seeds].flatMap((s) => index.get(s).campaigns))].sort(),
      dprk_naming: DPRK_NAMING.test(login) || undefined,
      job_word_digits: JOB_WORD_DIGITS.test(login) || undefined,
    });
  }
  rows.sort((a, b) => b.score - a.score || b.mutual - a.mutual || a.login.localeCompare(b.login));
  console.log(`${candidates.size} account(s) outside the index touch the seeds; ${rows.length} touch ${min} or more`);

  // The profile tells a persona from a popular account: age, size, and
  // whatever contact points it carries.
  const previous = fs.existsSync(LEADS) ? JSON.parse(fs.readFileSync(LEADS, "utf8")).leads || [] : [];
  const cached = new Map(previous.filter((p) => p.profile).map((p) => [p.login, p.profile]));
  for (const row of rows.slice(0, top)) {
    let profile = cached.get(row.login);
    if (!profile) {
      const { status, json } = await ghGet(`users/${row.login}`);
      profile = json
        ? {
            type: json.type,
            name: json.name,
            company: json.company,
            blog: json.blog || null,
            location: json.location,
            email: json.email,
            bio: json.bio,
            twitter: json.twitter_username,
            created_at: json.created_at,
            public_repos: json.public_repos,
            followers: json.followers,
            following: json.following,
          }
        : { missing: status === 404 };
    }
    row.profile = profile;
    if (profile.followers >= POPULAR || profile.following >= POPULAR) row.popular = true;
    // The share of the account's whole follow network that is held accounts.
    // Follow-for-follow hubs touch dozens of seeds among tens of thousands of
    // others; a persona's small network is mostly its own group.
    const degree = (profile.followers || 0) + (profile.following || 0);
    if (degree) row.concentration = Math.round((1000 * (row.seeds + row.mutual)) / degree) / 1000;
  }
  // Hubs last, then by concentration weighted by how many seeds it touches.
  const weight = (r) => (r.popular || r.profile?.missing ? -1 : (r.concentration || 0) * Math.sqrt(r.seeds));
  const head = rows.slice(0, top).sort((a, b) => weight(b) - weight(a) || b.score - a.score);
  rows = [...head, ...rows.slice(top)];
  const out = {
    _comment:
      "Leads from scripts/gh-follow-graph.js rank: GitHub accounts outside the index connected by follows to several indexed operator accounts. Signals for review, never findings; see docs/gh-follow-graph.md.",
    ranked_at: new Date().toISOString().slice(0, 10),
    seeds_read: Object.keys(graph.accounts).length,
    min_seeds: min,
    leads: rows,
  };
  writeFileAtomic(LEADS, JSON.stringify(out, null, 1) + "\n");
  for (const r of rows.slice(0, 40)) {
    const p = r.profile || {};
    const flags = [r.popular && "popular", r.dprk_naming && "dprk-naming", r.job_word_digits && "job-word", p.missing && "removed"]
      .filter(Boolean)
      .join(",");
    console.log(
      `${String(r.concentration ?? "-").padStart(5)}  ${r.login.padEnd(28)} seeds=${r.seeds} mutual=${r.mutual} ` +
        `created=${(p.created_at || "").slice(0, 10)} repos=${p.public_repos ?? "?"} ` +
        `followers=${p.followers ?? "?"} following=${p.following ?? "?"} ${flags}`
    );
  }
}

const [mode, ...rest] = process.argv.slice(2);
const run = mode === "collect" ? collect : mode === "rank" ? rank : null;
if (!run) {
  console.error("usage: node scripts/gh-follow-graph.js collect [--limit N] [--force] | rank [--min N] [--top N]");
  process.exit(2);
}
run(rest).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
