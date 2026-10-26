/**
 * candidate-confidence.js — the screening confidence of a candidate row
 * ==========================================================================
 * A candidate's confidence (high / medium / low) is how strongly the row
 * matches the screening signals in candidates.json `heuristics`, and nothing
 * more: it is not a source's characterisation and not an attribution. It was
 * once set by hand row by row, which let it drift (a VoIP number added to a
 * row without its confidence being revisited); it is now computed from the
 * row's matched signals, and the validator fails a row whose stored value
 * disagrees.
 *
 * Points per signal:
 *   4  name-mismatch together with recent-account: a differently named
 *      account created for the purpose, the pattern _drafts/private/docs/pipu-lead-screening.md
 *      identifies as pointing at an operator
 *   2  voip-number, shared-resume-text, photo-name-mismatch,
 *      shared-claimed-employer and reused-employer (a link to another
 *      identity), and corroborated: a cited source names the account (the
 *      row carries corroboration[]); candidateSignals adds it
 *   1  name-mismatch on its own (a real, established account under another
 *      name is the stolen identity, not the operator),
 *      and each other supporting sign
 *   0  signs true of ordinary job seekers (role-title, open-to-work,
 *      keyword-stuffed-headline, all-roles-remote, vanity-slug-pattern), the
 *      marketplace listing itself (every pipu row has it), and signs that cut
 *      both ways (real-namesake-account, duplicate-name-account)
 *
 * high: 4 or more AND at least one strong sign (a 2- or 4-point one), so weak
 *       signs alone never reach it
 * medium: 2 or more
 * low: 1 or less
 */
"use strict";

const STRONG = new Set([
  "voip-number",
  "shared-resume-text",
  "photo-name-mismatch",
  "shared-claimed-employer",
  "reused-employer",
  "corroborated",
]);
const ZERO = new Set([
  "marketplace-resume",
  "real-namesake-account",
  "duplicate-name-account",
  "role-title",
  "open-to-work",
  "keyword-stuffed-headline",
  "all-roles-remote",
  "vanity-slug-pattern",
]);

function candidateScore(signals) {
  const set = new Set(signals || []);
  let score = 0;
  let strong = false;
  if (set.has("name-mismatch") && set.has("recent-account")) {
    score += 4;
    strong = true;
    set.delete("name-mismatch");
    set.delete("recent-account");
  }
  for (const s of set) {
    if (ZERO.has(s)) continue;
    if (STRONG.has(s)) {
      score += 2;
      strong = true;
    } else {
      score += 1;
    }
  }
  return { score, strong };
}

function candidateConfidence(signals) {
  const { score, strong } = candidateScore(signals);
  if (score >= 4 && strong) return "high";
  return score >= 2 ? "medium" : "low";
}

// The signals a row is scored on: its matched heuristics, voip-number where
// its recorded line type is VoIP, and corroborated where a source names it.
function candidateSignals(row) {
  const signals = new Set(row.matched_indicators || []);
  const facts = row.facts || {};
  if (facts.line_type === "VoIP") signals.add("voip-number");
  if ((row.corroboration || []).length) signals.add("corroborated");
  return [...signals];
}

module.exports = { candidateScore, candidateConfidence, candidateSignals };
