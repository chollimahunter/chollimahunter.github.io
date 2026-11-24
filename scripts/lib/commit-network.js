/**
 * commit-network.js — pure helpers for scripts/gh-commit-network.js.
 * No network and no filesystem, so the grouping can be tested without GitHub.
 *
 * The pivot reads every commit GitHub attributes to an indexed account,
 * anywhere on GitHub, and asks three questions of them: whose repositories the
 * account works in, which author names it commits under, and which addresses.
 * A repository two personas both commit to is a team repository; an author
 * name shaped like another login is often a second account's handle (gigi0500
 * committed as "wstar0209", the former name of a separate account); an
 * address the index lacks is the account's own.
 */
"use strict";

const { isNoreply, noreplyIdentity } = require("./identity-pivot.js");

const lower = (v) => String(v || "").trim().toLowerCase();
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const squash = (v) => lower(v).replace(/[^a-z0-9]/g, "");

/** Gmail ignores dots and anything after a plus; the index stores the folded form. */
function fold(email) {
  const [local, domain] = lower(email).split("@");
  if (!domain) return lower(email);
  if (domain === "gmail.com" || domain === "googlemail.com") return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  return `${local}@${domain}`;
}

/** One commit-search item reduced to what the ranking needs. */
function commitFrom(item, via) {
  const a = (item.commit && item.commit.author) || {};
  const email = lower(a.email);
  const nr = noreplyIdentity(email);
  return {
    repo: (item.repository && item.repository.full_name) || null,
    sha: String(item.sha || "").slice(0, 12),
    date: String(a.date || "").slice(0, 10),
    name: String(a.name || "").trim(),
    email: email && !isNoreply(email) ? email : null,
    noreply_login: nr ? nr.login : null,
    via,
  };
}

/** Author names that say nothing about an identity. */
const GENERIC_NAMES = new Set(["root", "admin", "user", "ubuntu", "dev", "developer", "unknown", "github", "your name", "you", "test", "me"]);

/** True when an author name is just the account's own login, or empty. */
function isOwnName(name, login, noreplyLogin) {
  const n = squash(name);
  return !n || n === squash(login) || (noreplyLogin && n === squash(noreplyLogin)) || GENERIC_NAMES.has(lower(name));
}

function bump(map, key, init, seed, commit) {
  const g = map.get(key) || init();
  g.seeds.add(seed);
  g.commits++;
  if (commit.repo && g.repos.size < 8) g.repos.add(commit.repo);
  if (commit.date && (!g.first || commit.date < g.first)) g.first = commit.date;
  if (commit.date && (!g.last || commit.date > g.last)) g.last = commit.date;
  map.set(key, g);
}

/**
 * Groups every account's commits into the three lead tables.
 * `accounts` is the collect file's map; `indexed` is a set of lower-cased
 * logins and folded addresses the index already holds.
 */
function network(accounts, indexed = new Set()) {
  const owners = new Map();
  const names = new Map();
  const emails = new Map();
  const empty = () => ({ seeds: new Set(), commits: 0, repos: new Set(), first: null, last: null });
  for (const acc of Object.values(accounts)) {
    const seed = acc.login;
    for (const c of acc.commits || []) {
      const owner = c.repo ? c.repo.split("/")[0] : null;
      if (owner && lower(owner) !== lower(seed)) bump(owners, lower(owner), () => ({ owner, ...empty() }), seed, c);
      if (!isOwnName(c.name, seed, c.noreply_login)) bump(names, lower(c.name), () => ({ name: c.name, ...empty() }), seed, c);
      if (c.email) bump(emails, fold(c.email), () => ({ email: fold(c.email), ...empty() }), seed, c);
    }
  }
  const finish = (g, key) => ({ ...g, seeds: [...g.seeds], repos: [...g.repos], indexed: indexed.has(key) });
  return {
    owners: [...owners.entries()].map(([k, g]) => finish(g, k)),
    names: [...names.entries()].map(([k, g]) => ({ ...finish(g, k), handle_shaped: LOGIN.test(g.name) && /\d/.test(g.name) })),
    emails: [...emails.entries()].map(([k, g]) => finish(g, k)),
  };
}

/**
 * The rows worth reading. A repository owner or an author name shared by two
 * or more indexed accounts is a lead whatever else it is; a handle-shaped
 * author name used by one account is a lead too, since it is how a second
 * account's handle shows up. An address is a lead when the index lacks it.
 */
function leads(net, { min = 2 } = {}) {
  const bySeeds = (a, b) => b.seeds.length - a.seeds.length || b.commits - a.commits;
  return {
    owners: net.owners.filter((g) => g.seeds.length >= min).sort(bySeeds),
    names: net.names.filter((g) => g.seeds.length >= min || (g.handle_shaped && !g.indexed)).sort(bySeeds),
    emails: net.emails.filter((g) => !g.indexed).sort(bySeeds),
  };
}

module.exports = { fold, commitFrom, isOwnName, network, leads };
