/**
 * operator-hosts.js — the hosts an indexed operator runs, which the site never
 * links to
 * ==========================================================================
 * A site the operators host or control is an indicator, not a reference: a
 * clickable link to it sends a reader to live infrastructure. The set is built
 * once from the merged index (src/_data/iocIndex.js exposes it as
 * `operator_hosts`), read by the `isOperatorSite` filter in .eleventy.js and
 * enforced over the built site by scripts/check-site.js.
 *
 * Only the full host a record names goes in. A shared platform apex
 * (vercel.app, github.io) or a platform the index tracks accounts on (GitHub,
 * LinkedIn, Telegram and the rest of PLATFORM_ACCOUNTS) is never added on its
 * own, since everybody else's pages live there too.
 */
"use strict";

const { PLATFORM_ACCOUNTS } = require("./ioc-normalize.js");

/** Types whose value is a web address on infrastructure the operator controls. */
const OPERATOR_SITE_TYPES = new Set(["hosted_site", "personal_site", "domain"]);

const SHARED_APEXES = new Set([
  "vercel.app", "netlify.app", "github.io", "web.app", "firebaseapp.com", "onrender.com",
  "fly.dev", "pages.dev", "workers.dev", "herokuapp.com", "glitch.me", "replit.app", "repl.co",
  "azurewebsites.net", "cloudfront.net", "amazonaws.com", "blogspot.com", "wordpress.com",
  "tistory.com", "medium.com", "notion.site", "gitbook.io", "wixsite.com", "substack.com",
  "github.com", "githubusercontent.com", "gitlab.com", "google.com", "linkedin.com",
  "x.com", "twitter.com", "t.me", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
]);
const PLATFORM_HOSTS = new Set(PLATFORM_ACCOUNTS.flatMap((spec) => spec.hosts || []));

/** Lower-cased host without "www." for a URL or a bare host, or null. */
function hostOf(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(text) && !/^[^:/]+:\d+(\/|$)/.test(text)) return null;
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return host.includes(".") ? host : null;
}

function operatorHosts(records) {
  const hosts = new Set();
  for (const record of records) {
    if (!OPERATOR_SITE_TYPES.has(record.ioc_type)) continue;
    // A personal site given as a path (about.me/name, contra.com/name) is a
    // profile page on somebody else's platform, not a site of its own.
    if (record.ioc_type === "personal_site" && /^(?:[a-z]+:\/\/)?[^/]+\/[^/?#]/i.test(record.value)) continue;
    const host = hostOf(record.value);
    if (!host || SHARED_APEXES.has(host) || PLATFORM_HOSTS.has(host)) continue;
    hosts.add(host);
  }
  return [...hosts].sort();
}

/** Whether a URL or bare host is on one of `hosts` (a Set). Never throws. */
function isOperatorHost(hosts, value) {
  const host = hostOf(value);
  return Boolean(host && hosts.has(host));
}

module.exports = { operatorHosts, isOperatorHost, hostOf, OPERATOR_SITE_TYPES, SHARED_APEXES };
