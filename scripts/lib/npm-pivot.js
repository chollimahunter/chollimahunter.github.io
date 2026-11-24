/**
 * npm-pivot.js — pure helpers for scripts/npm-pivot.js.
 * No network and no filesystem: these take parsed registry documents.
 *
 * A package's registry document records more than the site has used: the
 * maintainers with their email addresses, the account that published each
 * version, every version's dependencies and the repository and homepage it
 * links. A malicious package that is still up therefore names its publisher's
 * address, the loader packages it chains to, and often the GitHub repository
 * it was built from. npm strips all of this from a package it has taken down
 * (a "security holding package"), so only live packages carry it.
 */
"use strict";

const lower = (v) => String(v || "").trim().toLowerCase();

/** npm's placeholder owner of taken-down packages, never an operator. */
const NPM_STAFF = new Set(["npm", "npm-support"]);

/** A GitHub owner/repo or owner from a repository, homepage or bugs URL. */
function githubFrom(url) {
  const m = String(url || "").match(/github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9._-]+?))?(?:\.git)?(?:[/#?].*)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] ? `${m[1]}/${m[2]}` : null };
}

const urlOf = (v) => (typeof v === "string" ? v : v && v.url) || null;

/** What one registry document says about who made the package and what it pulls in. */
function readPackument(doc) {
  if (!doc || !doc.name) return null;
  const versions = Object.values(doc.versions || {});
  const holding = /security holding package/i.test(doc.description || "") || versions.every((v) => /-security$/.test(v.version || ""));
  const people = new Map();
  const addPerson = (p, role) => {
    if (!p || typeof p !== "object") return;
    const name = lower(p.name);
    const email = lower(p.email);
    if (NPM_STAFF.has(name) || email === "npm@npmjs.com") return;
    const key = name || email;
    if (!key) return;
    const g = people.get(key) || { name: name || null, emails: new Set(), roles: new Set() };
    if (email) g.emails.add(email);
    g.roles.add(role);
    people.set(key, g);
  };
  for (const m of doc.maintainers || []) addPerson(m, "maintainer");
  const deps = new Set();
  const links = new Set();
  for (const v of versions) {
    addPerson(v._npmUser, "publisher");
    if (v.author && typeof v.author === "object" && v.author.email) addPerson({ name: null, email: v.author.email }, "author");
    for (const d of Object.keys({ ...(v.dependencies || {}), ...(v.optionalDependencies || {}) })) deps.add(d);
    for (const u of [urlOf(v.repository), v.homepage, urlOf(v.bugs)]) if (u) links.add(u);
  }
  for (const u of [urlOf(doc.repository), doc.homepage, urlOf(doc.bugs)]) if (u) links.add(u);
  const github = new Map();
  for (const u of links) {
    const g = githubFrom(u);
    if (g && lower(g.owner) !== "npm") github.set(lower(g.repo || g.owner), g);
  }
  return {
    name: doc.name,
    holding,
    created: (doc.time && doc.time.created) || null,
    versions: versions.length,
    people: [...people.values()].map((p) => ({ name: p.name, emails: [...p.emails], roles: [...p.roles] })),
    dependencies: [...deps].sort(),
    github: [...github.values()],
  };
}

/** Package names from a registry search response. */
function namesFromSearch(res) {
  return ((res && res.objects) || []).map((o) => o.package && o.package.name).filter(Boolean);
}

/**
 * Leads from the collected data, against what the index already holds
 * (`indexed` holds package names, npm account names, folded addresses and
 * lower-cased GitHub logins). `downloads` maps a package to its weekly
 * download count where it was looked up.
 */
function leads(data, indexed, { maxDownloads = 1000 } = {}) {
  const packages = new Map();
  const accounts = new Map();
  const emails = new Map();
  const github = new Map();
  const deps = new Map();
  const note = (map, key, init, from) => {
    const g = map.get(key) || init();
    g.from.add(from);
    map.set(key, g);
    return g;
  };
  for (const [maintainer, m] of Object.entries(data.maintainers || {})) {
    if (NPM_STAFF.has(maintainer)) continue;
    for (const name of m.packages || []) {
      if (!indexed.has(lower(name))) note(packages, lower(name), () => ({ name, from: new Set() }), maintainer);
    }
  }
  for (const p of Object.values(data.packages || {})) {
    if (!p || p.error) continue;
    for (const person of p.people || []) {
      if (NPM_STAFF.has(person.name) || person.emails.some((e) => /@npmjs\.com$/.test(e))) continue;
      if (person.name && !indexed.has(`npm:${person.name}`)) {
        const g = note(accounts, person.name, () => ({ name: person.name, emails: new Set(), from: new Set() }), p.name);
        for (const e of person.emails) g.emails.add(e);
      }
      for (const e of person.emails) if (!indexed.has(e)) note(emails, e, () => ({ email: e, from: new Set() }), p.name);
    }
    for (const g of p.github || []) {
      if (!indexed.has(lower(g.owner))) note(github, lower(g.repo || g.owner), () => ({ ...g, from: new Set() }), p.name);
    }
    for (const d of p.dependencies || []) {
      const dl = (data.downloads || {})[d];
      if (indexed.has(lower(d)) || dl === undefined || dl === null || dl > maxDownloads) continue;
      note(deps, lower(d), () => ({ name: d, downloads: dl, from: new Set() }), p.name);
    }
  }
  const out = (map) => [...map.values()].map((g) => ({ ...g, from: [...g.from], ...(g.emails ? { emails: [...g.emails] } : {}) })).sort((a, b) => b.from.length - a.from.length);
  return { packages: out(packages), accounts: out(accounts), emails: out(emails), github: out(github), dependencies: out(deps) };
}

module.exports = { githubFrom, readPackument, namesFromSearch, leads };
