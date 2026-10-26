/**
 * etherhiding-review-gate.js (library)
 * ==============================================================
 * Decides whether an EtherHiding refresh may be merged unattended, and lists
 * the new on-chain values it brings for a person to review afterwards. Pure
 * function over the parsed findings, so it can be unit-tested; the CLI in
 * scripts/etherhiding-review-gate.js prints its answer for the workflow.
 *
 * What merges on its own: anything a refresh adds. A new C2 value the operator
 * wrote, a new rotation, a nonce advance, a rotated payload or replaced
 * bytecode is an on-chain observation, and the tracker shows a host nobody has
 * reviewed with an "unreviewed" badge. None of it becomes an indicator: a host
 * reaches the index only when a person files it, and parked values are recorded in
 * scripts/data/etherhiding-c2-review.json. Each new value is listed in the
 * output so the workflow can post it for that review.
 *
 * What holds the run for a person (fail closed):
 *   - no previous findings file to compare with;
 *   - a degraded run: more than MAX_FAILED_SHARE of its chain queries failed;
 *   - data loss: an observation, a rotation run, a mapping operator, a write
 *     in mapping_history, a payload or deployed code that the previous run
 *     recorded and this one does not, or a counter that went backwards;
 *   - rewritten history: a recorded rotation run or write whose identity
 *     changed, or a transaction observation whose fields changed;
 *   - anything the gate does not know: an observation field, a change type or
 *     a top-level key outside the lists below, or a new observation with no
 *     watchlist entry behind it.
 */
"use strict";

const OBSERVATION_FIELDS = new Set([
  "id", "target", "kind", "chain", "block", "nonce", "balance_wei", "rotation", "resolver",
  "code_bytes", "code_sha256", "shape_score", "shape_reasons", "nullreceiver_shape",
  "mapping", "mapping_writes", "mapping_history", "payload", "payload_writes", "storage_incomplete",
  "calldata_bytes", "calldata_sha256", "to", "from",
]);
const TOP_LEVEL_FIELDS = new Set([
  "scan_id", "ran_at", "ruleset_version", "matches", "changes", "observations", "queries_executed", "status_note",
]);
const CHANGE_TYPES = new Set([
  "first observation", "operator activity", "payload rotated", "payload appeared", "bytecode replaced", "C2 rotated",
]);
const MAX_FAILED_SHARE = 0.05;

const keyOf = (o) => `${o.chain}:${String(o.target).toLowerCase()}`;
const ipsOf = (run) => run.resolved_ips || (run.resolved_ip ? [run.resolved_ip] : []);

function failedShare(findings) {
  const queries = findings.queries_executed || [];
  if (!queries.length) return 0;
  return queries.filter((q) => / -- FAILED/.test(String(q))).length / queries.length;
}

/** Holds and new values for one observation seen in both runs. */
function compareObservation(key, now, then, holds, fresh) {
  for (const field of Object.keys(now)) {
    if (!OBSERVATION_FIELDS.has(field)) holds.push(`${key} carries a field the gate does not know: ${field}`);
  }
  if (typeof then.nonce === "number" && (typeof now.nonce !== "number" || now.nonce < then.nonce)) {
    holds.push(`${key} nonce went from ${then.nonce} to ${now.nonce}`);
  }
  if (typeof then.mapping_writes === "number" && !(now.mapping_writes >= then.mapping_writes)) {
    holds.push(`${key} mapping_writes went from ${then.mapping_writes} to ${now.mapping_writes}`);
  }
  if (then.code_sha256 && !now.code_sha256) holds.push(`${key} deployed code was recorded before and is missing now`);
  if (then.code_sha256 && now.code_sha256 && then.code_sha256 !== now.code_sha256) fresh.push(`${key} bytecode replaced`);
  if (then.payload && !now.payload) holds.push(`${key} stored payload was recorded before and is missing now`);
  if (then.payload && now.payload && then.payload.sha256 !== now.payload.sha256) fresh.push(`${key} stored payload rotated`);
  for (const field of ["calldata_sha256", "to", "from"]) {
    if (then[field] !== undefined && JSON.stringify(then[field]) !== JSON.stringify(now[field])) {
      holds.push(`${key} transaction field ${field} changed`);
    }
  }

  // Rotation: every recorded run must still be there with the same identity;
  // only its end date, count and last transaction may grow. Runs after the
  // last recorded one are new.
  const before = then.rotation || [];
  const after = now.rotation || [];
  if (before.length && !after.length) holds.push(`${key} rotation history was recorded before and is missing now`);
  else {
    before.forEach((run, i) => {
      const cur = after[i];
      if (!cur || cur.to !== run.to || cur.from !== run.from || cur.first_tx !== run.first_tx || !(cur.count >= run.count)) {
        holds.push(`${key} rotation run ${i + 1} (${run.to}) was rewritten or lost`);
      }
    });
    for (const run of after.slice(before.length)) {
      const ips = ipsOf(run);
      fresh.push(`${key} now points at ${run.to}${ips.length ? ` (${ips.join(", ")})` : ""} since ${run.from}`);
    }
  }

  // Mapping: every operator recorded before must still be read; a changed
  // value is the operator rotating its C2 string.
  const mapBefore = new Map((then.mapping || []).map((m) => [m.operator, m.value]));
  const mapAfter = new Map((now.mapping || []).map((m) => [m.operator, m.value]));
  for (const [operator, value] of mapBefore) {
    if (!mapAfter.has(operator)) holds.push(`${key} mapping for ${operator} was read before and is missing now`);
    else if (mapAfter.get(operator) !== value) fresh.push(`${key} ${operator} now writes ${JSON.stringify(mapAfter.get(operator))}`);
  }
  for (const [operator, value] of mapAfter) {
    if (!mapBefore.has(operator)) fresh.push(`${key} new operator ${operator} writes ${JSON.stringify(value)}`);
  }

  // Write history: every recorded write must still be there, by transaction.
  const histAfter = new Set((now.mapping_history || []).map((w) => w.tx));
  const histBefore = new Set((then.mapping_history || []).map((w) => w.tx));
  for (const w of then.mapping_history || []) {
    if (!histAfter.has(w.tx)) holds.push(`${key} recorded write ${w.tx} is missing now`);
  }
  for (const w of now.mapping_history || []) {
    if (!histBefore.has(w.tx)) fresh.push(`${key} wrote ${JSON.stringify(w.value)} on ${w.since}`);
  }
}

/**
 * @param latest   the findings file the refresh wrote
 * @param previous the findings file as the previous run left it
 * @returns {{ needsReview: boolean, reasons: string[], fresh: string[], total: number }}
 */
function gateDecision(latest, previous) {
  const holds = [];
  const fresh = [];
  const changes = latest.changes || [];
  if (!previous) {
    return { needsReview: true, reasons: ["no previous findings file to compare against"], fresh, total: changes.length };
  }

  for (const key of new Set([...Object.keys(latest), ...Object.keys(previous)])) {
    if (!TOP_LEVEL_FIELDS.has(key)) holds.push(`top-level key the gate does not know: ${key}`);
  }
  for (const change of changes) {
    if (!CHANGE_TYPES.has(change.change)) holds.push(`${change.change} on ${change.chain} ${change.target}`);
  }
  const share = failedShare(latest);
  if (share > MAX_FAILED_SHARE) {
    holds.push(`${Math.round(share * 100)}% of this run's chain queries failed, so it may have missed what it would normally record`);
  }

  // A watchlist edit (a new ruleset version) is the one thing that may remove
  // an observation: the entry behind it is gone.
  const watchlistChanged = JSON.stringify(latest.ruleset_version) !== JSON.stringify(previous.ruleset_version);
  const before = new Map((previous.observations || []).filter(Boolean).map((o) => [keyOf(o), o]));
  const after = new Map((latest.observations || []).filter(Boolean).map((o) => [keyOf(o), o]));
  for (const [key, then] of before) {
    if (!after.has(key) && !watchlistChanged) holds.push(`observation ${key} disappeared`);
  }
  for (const [key, now] of after) {
    const then = before.get(key);
    if (!then) {
      if (!now.id) holds.push(`new observation ${key} has no watchlist entry behind it`);
      else fresh.push(`${key} first observed (${now.id})`);
      continue;
    }
    compareObservation(key, now, then, holds, fresh);
  }
  return { needsReview: holds.length > 0, reasons: holds, fresh, total: changes.length };
}

module.exports = { gateDecision, failedShare, OBSERVATION_FIELDS, CHANGE_TYPES, MAX_FAILED_SHARE };
