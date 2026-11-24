/**
 * holder-check.js — pure scoring for scripts/gh-holder-check.js.
 *
 * An indexed address that GitHub attributes to an established developer is a
 * possible false positive: a bulk list that picked up a real person's address,
 * an identity an operator borrows, or a handle the developer used first. On 22
 * and 23 November 2026, 35 values were withdrawn on exactly this evidence,
 * every one found by reading holders by hand. These signals are what that
 * reading weighed; none settles anything alone, and a high score is a reason
 * to read the account, not a ruling.
 */
"use strict";

const YEAR = 365.25 * 86400000;

/** Signals that a GitHub account is a long-standing real developer. */
function signals(profile, holding, now = Date.now()) {
  const out = [];
  if (!profile) return out;
  const age = (now - Date.parse(profile.created_at)) / YEAR;
  if (age >= 8) out.push(`account ${Math.floor(age)} years old`);
  else if (age >= 5) out.push(`account ${Math.floor(age)} years old`);
  if ((profile.followers || 0) >= 25) out.push(`${profile.followers} followers`);
  if ((profile.public_repos || 0) >= 30) out.push(`${profile.public_repos} repositories`);
  if (profile.company) out.push(`employer "${String(profile.company).trim()}"`);
  if (profile.blog) out.push("personal site");
  if (/^\p{Lu}[\p{L}'-]+\s+\p{Lu}[\p{L}'-]+/u.test(String(profile.name || ""))) out.push(`real-name display "${profile.name}"`);
  if (holding && holding.first && holding.last) {
    const span = (Date.parse(holding.last) - Date.parse(holding.first)) / YEAR;
    if (span >= 3) out.push(`commits with the address over ${Math.floor(span)} years`);
  }
  return out;
}

/** Weight: age counts double past eight years, the rest one each. */
function score(sig) {
  return sig.reduce((n, s) => n + (/years old/.test(s) && Number(s.match(/\d+/)[0]) >= 8 ? 2 : 1), 0);
}

module.exports = { signals, score };
