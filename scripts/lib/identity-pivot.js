/**
 * identity-pivot.js — pure helpers for scripts/gh-identity-pivot.js.
 * No network and no filesystem: everything here takes parsed API payloads and
 * returns plain data, so it can be tested without GitHub.
 */
"use strict";

const NOREPLY = /@users\.noreply\.github\.com$/i;
const NOREPLY_WITH_ID = /^(\d+)\+([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;

const lower = (v) => String(v || "").trim().toLowerCase();

/** True for an address GitHub itself issues; it identifies no mailbox. */
function isNoreply(email) {
  return NOREPLY.test(lower(email));
}

/** `{ id, login }` from `<id>+<login>@users.noreply.github.com`, else null. */
function noreplyIdentity(email) {
  const m = lower(email).match(NOREPLY_WITH_ID);
  return m ? { id: Number(m[1]), login: m[2] } : null;
}

/** Adds one observation to a map of key -> [{ repo, sha }], keeping the first few. */
function note(map, key, where, cap = 3) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  const list = map.get(key);
  if (list.length < cap && !list.some((w) => w.sha === where.sha)) list.push(where);
}

const emptyIdentities = () => ({ emails: new Map(), names: new Map(), noreplyIds: new Map() });

function addCommitIdentity(into, a, where) {
  const email = lower(a.email);
  if (email && isNoreply(email)) {
    if (noreplyIdentity(email)) note(into.noreplyIds, email, where);
  } else {
    note(into.emails, email, where);
  }
  note(into.names, String(a.name || "").trim(), where);
}

/**
 * Reads author names and addresses out of a repository's commit list, keeping
 * only commits GitHub attributes to `login` (author.login), which is what
 * separates the account's own commits from commits it merely carries.
 */
function identitiesFromCommits(commits, login, repo, into = emptyIdentities()) {
  for (const c of commits || []) {
    if (lower(c && c.author && c.author.login) !== lower(login)) continue;
    addCommitIdentity(into, (c.commit && c.commit.author) || {}, { repo, sha: String(c.sha || "").slice(0, 12) });
  }
  return into;
}

/** The same, from /users/{u}/events/public PushEvent payloads. */
function identitiesFromEvents(events, into = emptyIdentities()) {
  for (const ev of events || []) {
    if (!ev || ev.type !== "PushEvent") continue;
    const repo = ev.repo && ev.repo.name;
    for (const c of (ev.payload && ev.payload.commits) || []) {
      addCommitIdentity(into, c.author || {}, { repo, sha: String(c.sha || "").slice(0, 12), via: "events" });
    }
  }
  return into;
}

/**
 * Other logins that committed with an address, from /search/commits items.
 * Returns Map login -> { repo, sha } (first occurrence), excluding `login`.
 */
function otherLogins(items, login) {
  const out = new Map();
  for (const it of items || []) {
    const l = it && it.author && it.author.login;
    if (!l || lower(l) === lower(login) || out.has(l)) continue;
    out.set(l, { repo: it.repository && it.repository.full_name, sha: String(it.sha || "").slice(0, 12) });
  }
  return out;
}

/** Splits `gh api --include` output into status, lower-cased headers and body text. */
function parseInclude(raw) {
  const text = String(raw).replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 2);
  const lines = head.split("\n");
  const status = Number((lines[0].match(/\s(\d{3})\b/) || [])[1]) || 0;
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, headers, body };
}

/** Seconds to wait after a 403/429, from Retry-After or the rate-limit reset, else a default. */
function backoffSeconds(headers, now = Date.now() / 1000, fallback = 60) {
  const ra = Number(headers["retry-after"]);
  if (Number.isFinite(ra) && ra > 0) return Math.ceil(ra);
  if (headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(reset)) return Math.max(1, Math.ceil(reset - now) + 1);
  }
  return fallback;
}

module.exports = {
  isNoreply,
  noreplyIdentity,
  emptyIdentities,
  identitiesFromCommits,
  identitiesFromEvents,
  otherLogins,
  parseInclude,
  backoffSeconds,
};
