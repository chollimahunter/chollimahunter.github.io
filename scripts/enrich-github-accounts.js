#!/usr/bin/env node
/**
 * enrich-github-accounts.js
 * ==============================================================
 * For every `github_profile` record in src/_data/iocs/scraped-iocs.json,
 * records whether the account still exists and mirrors its avatar locally.
 * Then does the same for every GitHub login in the three dossier files
 * (x-dossiers.json, third-party-registries.json, direct-observations.json),
 * writing scripts/data/github-account-status.json, which scripts/lib/dossiers.js
 * attaches to those records at build time.
 *
 * Run manually:
 *   node scripts/enrich-github-accounts.js            # only unchecked accounts
 *   node scripts/enrich-github-accounts.js --force    # re-check everything
 *
 * RECYCLED LOGINS (dossier phase)
 * -------------------------------
 * GitHub frees a deleted account's login for anyone to register. The dossier
 * phase asks `gh api users/<login>` for the account's creation date, and an
 * account created after the login was first reported cannot be the account the
 * report named: it is recorded as `recycled`, with both dates and no avatar.
 * `gh` authenticates without exposing a token (5,000 requests an hour). Where
 * `gh` is unavailable the phase falls back to the web endpoints below and
 * cannot detect recycling, and says so.
 *
 * WHY THE WEB ENDPOINTS, NOT THE API
 * ----------------------------------
 * api.github.com allows 60 unauthenticated requests an hour, which is roughly
 * seven hours for the accounts currently indexed. github.com/<login> and
 * github.com/<login>.png answer the same two questions without that cap:
 * 200 means the account is live, 404 means it is gone.
 *
 * WHY MIRROR THE IMAGE
 * --------------------
 * The site forbids external image dependencies (see .eleventy.js), so hotlinking
 * avatars.githubusercontent.com is not an option.
 *
 * WHAT AN AVATAR IS AND IS NOT
 * ----------------------------
 * It is the picture the account presents. It is NOT evidence of who operates
 * the account: DPRK IT-worker personas routinely use stock imagery or photos
 * taken from uninvolved real people. The profile page says so next to every
 * one. Do not treat a face here as a picture of an operator.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");

const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "src", "_data", "iocs", "scraped-iocs.json");
const DOSSIER_FILES = ["x-dossiers.json", "third-party-registries.json", "direct-observations.json"];
const DOSSIER_STATUS_PATH = path.join(ROOT, "scripts", "data", "github-account-status.json");
const AVATAR_DIR = path.join(ROOT, "src", "assets", "img", "github");
const AVATAR_URL_BASE = "/assets/img/github";

const USER_AGENT =
  "ChollimaHunterScraper/1.0 (+https://chollimahunter.github.io/; public DPRK threat-intel index)";
const DELAY_MS = 400;
const AVATAR_SIZE = 200;
// Avatars render in card grids at most ~300 CSS px wide (see CLAUDE.md), so a
// mirrored image is capped well above that on its long edge rather than kept
// at whatever size GitHub happened to serve.
const AVATAR_MAX_EDGE = 512;
const AVATAR_WEBP_QUALITY = 82;

const KNOWN_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Re-encodes an image buffer to WebP (quality 82, method 6), downscaling to
// AVATAR_MAX_EDGE on the long edge if larger, and preserving transparency
// when the source has an alpha channel. Shells out to Pillow the same way
// scripts/pivot-handles-maigret.js shells out to python for maigret — there
// is no image library in this project's own dependencies (no sharp, and this
// repo does not add npm packages for a single script).
const WEBP_CONVERT_SCRIPT = `
import sys, io
from PIL import Image
data = sys.stdin.buffer.read()
im = Image.open(io.BytesIO(data))
has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
im = im.convert("RGBA" if has_alpha else "RGB")
w, h = im.size
long_edge = max(w, h)
if long_edge > ${AVATAR_MAX_EDGE}:
    scale = ${AVATAR_MAX_EDGE} / long_edge
    im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
im.save(sys.stdout.buffer, "WEBP", quality=${AVATAR_WEBP_QUALITY}, method=6)
`;

function convertToWebp(buffer) {
  const result = spawnSync("python", ["-c", WEBP_CONVERT_SCRIPT], {
    input: buffer,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout || !result.stdout.length) {
    return null;
  }
  return result.stdout;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub's own rule for a login: alphanumeric or hyphen, no leading/trailing/
// doubled hyphen implied by this shape, 1-39 characters. The value here is a
// stored record's URL, not something GitHub validated for us, so a login that
// doesn't fit is treated as unusable rather than fetched anyway.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function loginOf(value) {
  const login = path.basename(String(value).split("/").filter(Boolean).pop() || "");
  return GITHUB_LOGIN_PATTERN.test(login) ? login : null;
}

async function checkAccount(login) {
  const response = await fetch(`https://github.com/${encodeURIComponent(login)}`, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return "removed";
  if (!response.ok) return "unknown";
  return "live";
}

/**
 * The account's numeric id, read out of the avatar redirect
 * (github.com/<login>.png -> avatars.githubusercontent.com/u/<id>).
 *
 * GitHub frees a deleted account's login for anyone to re-register, and this
 * script's live/removed check cannot see that: a recycled handle answers 200
 * and reads as live, so the site would present whoever holds it now as the
 * reported account. The id is what distinguishes them, and recording it makes
 * the substitution detectable on the next run rather than never.
 *
 * Two indexed accounts were already in that state when this was added, both
 * registered weeks after the report that named them. See the "recycled" state
 * in src/indicators/indicator-page.njk for how that is presented.
 *
 * Uses the same unauthenticated web endpoint as the rest of this script, so it
 * costs nothing against api.github.com's 60-an-hour cap.
 */
async function fetchAccountId(login) {
  const response = await fetch(`https://github.com/${encodeURIComponent(login)}.png`, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const match = /\/u\/(\d+)/.exec(response.headers.get("location") || "");
  return match ? Number(match[1]) : null;
}

async function fetchAvatar(login) {
  const response = await fetch(
    `https://github.com/${encodeURIComponent(login)}.png?size=${AVATAR_SIZE}`,
    { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok) return null;
  const type = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!KNOWN_IMAGE_TYPES.has(type)) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) return null;
  const webp = convertToWebp(buffer);
  if (!webp) return null;
  const filename = path.basename(`${login.toLowerCase()}.webp`);
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  fs.writeFileSync(path.join(AVATAR_DIR, filename), webp);
  return `${AVATAR_URL_BASE}/${filename}`;
}

async function main() {
  const force = process.argv.includes("--force");
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const accounts = data.records.filter((record) => record.ioc_type === "github_profile");
  const today = new Date().toISOString().slice(0, 10);

  const queue = accounts.filter((record) => force || !record.account_status);
  console.log(`${accounts.length} GitHub account(s) indexed, ${queue.length} to check.`);

  let live = 0;
  let removed = 0;
  let avatars = 0;
  let failed = 0;

  for (const [index, record] of queue.entries()) {
    const login = loginOf(record.value);
    if (!login) {
      console.error(`  skipping record with invalid login: ${record.value}`);
      failed += 1;
      continue;
    }
    // A record already marked recycled is left alone. The login still
    // resolves, so the live/removed check would call it live on every run and
    // undo the finding — and re-mirror the avatar of whoever holds it now,
    // which is the one image this site must not publish for that account.
    if (record.account_status && record.account_status.state === "recycled") continue;
    try {
      const state = await checkAccount(login);
      // Only a live account has an avatar worth mirroring; a removed one
      // returns GitHub's generic 404 body.
      const avatar = state === "live" ? await fetchAvatar(login) : null;
      const accountId = state === "live" ? await fetchAccountId(login) : null;
      record.account_status = { state, checked: today, avatar };
      if (accountId) record.account_status.account_id = accountId;
      if (state === "live") live += 1;
      if (state === "removed") removed += 1;
      if (avatar) avatars += 1;
    } catch (err) {
      // Leave the record unenriched so the next run retries it, rather than
      // recording a wrong state.
      failed += 1;
      console.error(`  ${login}: ${err.message}`);
    }
    if ((index + 1) % 50 === 0) console.log(`  ...${index + 1}/${queue.length}`);
    if (index < queue.length - 1) await sleep(DELAY_MS);
  }

  data.generated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileAtomic(DATA_PATH, JSON.stringify(data, null, 2) + "\n");

  console.log(`\nlive: ${live}, removed: ${removed}, avatars mirrored: ${avatars}, failed: ${failed}`);
  const dossierChanged = await enrichDossierAccounts(force, today);
  console.log(`CHANGED=${(queue.length > 0 && failed < queue.length) || dossierChanged}`);
}

// `gh api users/<login>`: the account's id and creation date, or removed on a
// 404. Returns null when gh itself is unavailable or fails for another reason,
// so the caller can fall back rather than record a wrong state.
function ghUser(login) {
  const result = spawnSync("gh", ["api", `users/${login}`, "--jq", "{id: .id, created_at: .created_at}"], {
    encoding: "utf8",
  });
  if (result.error) return null;
  if (result.status === 0) {
    const user = JSON.parse(result.stdout);
    return { state: "live", id: user.id, created: String(user.created_at).slice(0, 10) };
  }
  if (/HTTP 404/.test(result.stderr || "")) return { state: "removed" };
  return null;
}

// A source's date is the page's date, and a thread or post can gain the login
// later (a reply, an edit). Calling a login recycled tells readers the account
// is someone else's, so a gap under a month is not treated as proof of it.
const RECYCLED_MIN_GAP_DAYS = 30;
const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 86400000;

// The earliest publication date of a source that named the login: the
// researcher posts and registries. A direct observation is left undated. It
// describes the account as it exists now, found through its present commits,
// and it also cites the older article that published an email address, which
// an account registered later can carry without being a recycled handle.
// record.first_seen is not used, because it can be the persona's first
// sighting rather than the login's.
function reportedDates(records) {
  const dates = new Map();
  for (const record of records) {
    const login = loginOf(record.value);
    if (!login) continue;
    const key = login.toLowerCase();
    const candidates = (record.direct ? [] : record.sources || [])
      .map((source) => source.published)
      .filter((date) => /^\d{4}-\d{2}-\d{2}/.test(String(date || "")))
      .map((date) => String(date).slice(0, 10));
    for (const date of candidates) {
      if (!dates.has(key) || date < dates.get(key).date) dates.set(key, { login, date });
    }
    if (!dates.has(key)) dates.set(key, { login, date: null });
  }
  return dates;
}

async function enrichDossierAccounts(force, today) {
  const { recordsFromDossiers } = require("./lib/dossiers.js");
  const iocDir = path.join(ROOT, "src", "_data", "iocs");
  const records = DOSSIER_FILES.flatMap((file) =>
    recordsFromDossiers(JSON.parse(fs.readFileSync(path.join(iocDir, file), "utf8"))).map((record) => ({
      ...record,
      direct: file === "direct-observations.json",
    }))
  ).filter((record) => record.ioc_type === "github_profile");
  const reported = reportedDates(records);

  const doc = JSON.parse(fs.readFileSync(DOSSIER_STATUS_PATH, "utf8"));
  const byLogin = new Map(doc.accounts.map((account) => [account.login.toLowerCase(), account]));
  const queue = [...reported.entries()].filter(([key]) => {
    const existing = byLogin.get(key);
    // A recycled finding is kept, for the reason given in main().
    if (existing && existing.state === "recycled") return false;
    return force || !existing;
  });
  console.log(`\n${reported.size} dossier GitHub login(s), ${queue.length} to check.`);

  const counts = { live: 0, removed: 0, recycled: 0, avatars: 0, failed: 0 };
  let ghWarned = false;
  for (const [index, [key, { login, date }]] of queue.entries()) {
    try {
      let entry;
      const user = ghUser(login);
      if (!user && !ghWarned) {
        console.error("  gh api unavailable; falling back to web endpoints, recycled logins will not be detected");
        ghWarned = true;
      }
      if (user && user.state === "removed") {
        entry = { login, state: "removed", checked: today };
      } else if (user && date && daysBetween(date, user.created) >= RECYCLED_MIN_GAP_DAYS) {
        entry = { login, state: "recycled", checked: today, account_id: user.id, account_created: user.created, reported: date };
      } else {
        const state = user ? "live" : await checkAccount(login);
        if (state === "unknown") throw new Error("unexpected response");
        entry = { login, state, checked: today };
        if (state === "live") {
          const accountId = user ? user.id : await fetchAccountId(login);
          if (accountId) entry.account_id = accountId;
          // Dates the persona's indicators where no report does; see
          // accountDates() in src/_data/iocIndex.js.
          if (user && user.created) entry.account_created = user.created;
          const avatar = await fetchAvatar(login);
          if (avatar) entry.avatar = avatar;
        }
      }
      const existing = byLogin.get(key);
      if (existing) Object.keys(existing).forEach((field) => delete existing[field]);
      if (existing) Object.assign(existing, entry);
      else {
        doc.accounts.push(entry);
        byLogin.set(key, entry);
      }
      counts[entry.state] += 1;
      if (entry.avatar) counts.avatars += 1;
    } catch (err) {
      counts.failed += 1;
      console.error(`  ${login}: ${err.message}`);
    }
    if ((index + 1) % 50 === 0) console.log(`  ...${index + 1}/${queue.length}`);
    if (index < queue.length - 1) await sleep(DELAY_MS);
  }

  if (queue.length) {
    doc.accounts.sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
    doc.checked = today;
    writeFileAtomic(DOSSIER_STATUS_PATH, JSON.stringify(doc, null, 2) + "\n");
  }
  console.log(
    `dossiers: live: ${counts.live}, removed: ${counts.removed}, recycled: ${counts.recycled}, ` +
      `avatars mirrored: ${counts.avatars}, failed: ${counts.failed}`
  );
  return queue.length > 0 && counts.failed < queue.length;
}

main().catch((err) => {
  console.error("Enrichment failed:", err.message);
  console.log("CHANGED=false");
  process.exitCode = 1;
});
