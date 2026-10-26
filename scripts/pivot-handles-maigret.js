#!/usr/bin/env node
/**
 * pivot-handles-maigret.js
 * ==============================================================
 * Runs Maigret (https://github.com/soxoj/maigret) over every account handle
 * the index holds and writes a REVIEW LIST, never a record.
 *
 * Run manually, from this machine, with Maigret installed
 * (`python -m pip install --user maigret`):
 *
 *   node scripts/pivot-handles-maigret.js                # handles not checked in 90 days
 *   node scripts/pivot-handles-maigret.js --limit 40     # a short pass
 *   node scripts/pivot-handles-maigret.js --handle kanbei0605 --handle code-0605
 *   node scripts/pivot-handles-maigret.js --force        # ignore the 90-day memory
 *   node scripts/pivot-handles-maigret.js --top-sites 300
 *   node scripts/pivot-handles-maigret.js --include-email-locals   # also the local parts of consumer-mail addresses (thousands)
 *
 * WHAT THIS IS FOR
 * ----------------
 * docs/handle-pivot.md explains the pivot: these operators reuse a login
 * across platforms, so the handle is what finds the next account, not the
 * address. The passes of 13 and 17 September 2026 asked six platforms by hand.
 * Maigret asks a few hundred in one go, which is the point, and also the
 * problem: a hit on a common handle is very often somebody else's account.
 *
 * So this script decides nothing. It records what Maigret found and writes an
 * HTML review page a person reads before anything is filed by hand into
 * src/_data/iocs/direct-observations.json, with the date it was read and the
 * note every such entry carries: the handle is what links the account, and
 * nothing establishes that one person holds both. That is also why it is not
 * a scheduled workflow: the value of the pivot is the judgment applied to
 * each hit, and a job nobody reads would file nothing or file everything.
 *
 * WHAT IS RECORDED
 * ----------------
 * _drafts/private/maigret-pivot.json keeps, per handle, the date of the last
 * pass and the sites Maigret reported as claimed, so the next pass skips
 * handles checked recently. It is a memory of what was asked, not a source:
 * nothing in it reaches the site.
 *
 * The review page goes to _drafts/handle-pivot/, which is gitignored, because
 * most of the accounts on it belong to real people who have nothing to do
 * with any of this and the repository is public.
 *
 * HOW HITS ARE SORTED
 * -------------------
 * A hit on a platform the index models (GitHub, GitLab, Telegram, X, Medium,
 * dev.to, Freelancer, CodeSandbox, Docker Hub, Keybase, Hugging Face, Trello,
 * Quora, Odnoklassniki) can become an indicator; a hit anywhere else can at
 * most be noted in an entry's unextracted[] list, since the repository has no
 * type for it. Hits Maigret established only from an HTTP status code are
 * marked weak, because a 200 from a site that answers 200 to everything is
 * not an account. A hit whose value the index already holds is marked so.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");

const ROOT = path.join(__dirname, "..");
// Both state files name accounts that share a handle with a persona, most of
// them other people's, so they live in the private checkout.
const { privatePath } = require("./lib/private-data.js");
const STATE_PATH = privatePath("maigret-pivot.json");
const PIVOT_PATH = privatePath("handle-pivot.json");
const REVIEW_DIR = path.join(ROOT, "_drafts", "handle-pivot");
const { PLATFORM_ACCOUNTS, normalizePlatformAccount, normalizeGithub } = require("./lib/ioc-normalize.js");
const { personaRecords } = require("../src/_data/personas.js");

const ACCOUNT_TYPES = new Set([
  "github_profile",
  ...PLATFORM_ACCOUNTS.map((p) => p.ioc_type),
]);

// Local parts at these hosts are logins the holder chose. A local part at a
// company domain is assigned and usually a real employee's name, so it is not
// a handle -- see docs/handle-pivot.md.
const CONSUMER_MAIL_HOSTS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.jp", "ymail.com", "protonmail.com", "proton.me", "pm.me",
  "icloud.com", "me.com", "mail.com", "gmx.com", "gmx.de", "yandex.com", "yandex.ru",
  "aol.com", "zoho.com", "tutanota.com", "tuta.io", "mail.ru", "qq.com", "163.com", "126.com",
]);

// host -> { ioc_type, normalize }. normalizePlatformAccount takes the platform
// spec and returns the normalizer for it, the same way the scraper builds them.
const MODELLED_HOSTS = new Map([
  ["github.com", { ioc_type: "github_profile", normalize: normalizeGithub }],
  // A gist page belongs to the GitHub account of the same login.
  ["gist.github.com", { ioc_type: "github_profile", normalize: (u) => normalizeGithub(String(u).replace("gist.github.com", "github.com")) }],
]);
for (const p of PLATFORM_ACCOUNTS) {
  const normalize = normalizePlatformAccount(p);
  for (const h of p.hosts) MODELLED_HOSTS.set(h, { ioc_type: p.ioc_type, normalize });
}
// Sites whose absence answer is a real 404, so a status-code check there is
// not the weak kind.
const RELIABLE_STATUS_HOSTS = new Set(["github.com", "gist.github.com", "gitlab.com"]);

function parseArgs(argv) {
  const out = { limit: Infinity, force: false, topSites: 500, maxAgeDays: 90, handles: [], timeout: 15, emailLocals: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--force") out.force = true;
    else if (a === "--top-sites") out.topSites = Number(argv[++i]);
    else if (a === "--max-age-days") out.maxAgeDays = Number(argv[++i]);
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--handle") out.handles.push(argv[++i]);
    else if (a === "--include-email-locals") out.emailLocals = true;
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

/** Every handle the index holds, with the personas it belongs to and the
 *  normalized values already indexed, so a hit that restates an indicator the
 *  site already carries is marked rather than proposed again. */
function collectHandles(includeEmailLocals) {
  const owners = new Map(); // handle -> Set(persona label)
  const indexed = new Set(); // normalized account values already held
  const add = (handle, label) => {
    const h = String(handle).trim();
    if (h.length < 3 || /^\d+$/.test(h)) return;
    if (!owners.has(h)) owners.set(h, new Set());
    if (label) owners.get(h).add(label);
  };
  for (const rec of personaRecords()) {
    const label = rec.persona_key
      ? rec.persona_key.replace(/^dossier /, "")
      : (rec.sources && rec.sources[0] && rec.sources[0].section) || "";
    if (ACCOUNT_TYPES.has(rec.ioc_type)) {
      indexed.add(String(rec.value).toLowerCase());
      const seg = String(rec.value).replace(/\/+$/, "").split("/").pop().replace(/^@/, "");
      add(seg, label);
    } else if (includeEmailLocals && rec.ioc_type === "email_address") {
      const [local, host] = String(rec.value).toLowerCase().split("@");
      if (host && CONSUMER_MAIL_HOSTS.has(host)) add(local.split("+")[0], label);
    }
  }
  // The earlier passes' handle list, so nothing they covered is dropped.
  const pivot = readJson(PIVOT_PATH, { handles: {} });
  for (const h of Object.keys(pivot.handles || {})) add(h, null);
  // What the earlier passes already asked and found, keyed handle -> platform
  // ioc_type, so a hit they found is marked known rather than proposed again.
  const PIVOT_TYPES = { gitlab: "gitlab_account", devto: "devto_account", keybase: "keybase_account", dockerhub: "dockerhub_account", huggingface: "huggingface_account" };
  const found = new Set();
  for (const [h, platforms] of Object.entries(pivot.handles || {})) {
    for (const [plat, state] of Object.entries(platforms)) if (state === "found" && PIVOT_TYPES[plat]) found.add(`${h.toLowerCase()}|${PIVOT_TYPES[plat]}`);
  }
  return { owners, indexed, found };
}

function classifyHit(site, handle) {
  // Maigret sometimes reports the probe URL (an API call) as the account URL,
  // Freelancer being the standing case; the site's own URL template with the
  // handle filled in is the page a person would open.
  let url = site.url_user || (site.status && site.status.url) || "";
  const template = site.site && site.site.url;
  if (template && (url.includes("/api/") || !url)) url = template.replace("{username}", handle);
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
  const modelled = MODELLED_HOSTS.get(host) || null;
  const value = modelled ? modelled.normalize(url) : null;
  const checkType = (site.site && site.site.checkType) || "";
  const trim = (u) => String(u || "").replace(/\/+$/, "");
  // A hit is weak when it rests on a status code from a site that may answer
  // 200 to anything, or when the URL Maigret reports is the site's front page
  // rather than a profile (Discord is the standing example).
  const weak = (checkType === "status_code" && !RELIABLE_STATUS_HOSTS.has(host)) || !url || trim(url) === trim(site.url_main);
  return {
    site_name: site.status ? site.status.site_name : "",
    url,
    ioc_type: modelled ? modelled.ioc_type : null,
    value,
    weak,
  };
}

function runMaigret(handle, opts, outDir) {
  const args = [
    "-m", "maigret", handle,
    "--top-sites", String(opts.topSites),
    "--dns-resolver", "threaded",
    "--no-recursion", "--no-extracting", "--no-progressbar",
    "--timeout", String(opts.timeout),
    "-J", "simple", "--folderoutput", outDir,
  ];
  const res = spawnSync("python", args, { encoding: "utf8", timeout: 15 * 60 * 1000 });
  if (res.error) throw res.error;
  const report = path.join(outDir, `report_${handle}_simple.json`);
  if (!fs.existsSync(report)) {
    return { error: (res.stderr || res.stdout || "").split("\n").filter(Boolean).slice(-3).join(" | ") };
  }
  const doc = readJson(report, {});
  const hits = Object.values(doc)
    .filter((s) => s.status && s.status.status === "Claimed")
    .map((site) => classifyHit(site, handle));
  const warnings = (res.stdout || "").split("\n").filter((l) => l.startsWith("[!]")).map((l) => l.trim());
  return { hits, warnings };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function writeReview(rows, date) {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(11, 16).replace(":", "");
  const file = path.join(REVIEW_DIR, `maigret-review-${date}-${stamp}.html`);
  const body = rows.map((r) => {
    const modelled = r.hits.filter((h) => h.ioc_type);
    const other = r.hits.filter((h) => !h.ioc_type);
    const li = (h) => `<li>${h.weak ? "<em>weak</em> " : ""}${h.indexed ? "<strong>already indexed</strong> " : ""}${escapeHtml(h.site_name)}: <a href="${escapeHtml(h.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(h.url)}</a>${h.value ? ` <code>${escapeHtml(h.ioc_type)} ${escapeHtml(h.value)}</code>` : ""}</li>`;
    return `<section><h2>${escapeHtml(r.handle)}</h2>
<p>Held by: ${r.personas.length ? r.personas.map(escapeHtml).join("; ") : "<em>earlier pass only</em>"}</p>
${r.error ? `<p class="err">Maigret failed: ${escapeHtml(r.error)}</p>` : ""}
${modelled.length ? `<h3>Platforms the index models (${modelled.length})</h3><ul>${modelled.map(li).join("")}</ul>` : ""}
${other.length ? `<h3>Other sites (${other.length}), unextracted[] at most</h3><ul>${other.map(li).join("")}</ul>` : ""}
${!r.error && !r.hits.length ? "<p>No claimed account on any site checked.</p>" : ""}
</section>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Maigret handle pivot ${date}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}section{border-top:1px solid #ccc;padding:1rem 0}h2{margin:0 0 .25rem}code{background:#eee;padding:0 .25em}.err{color:#a00}em{color:#a60}</style></head>
<body><h1>Maigret handle pivot, ${date}</h1>
<p>${rows.length} handles checked. A hit here is a claim that an account exists under the handle, nothing more. Before filing anything into direct-observations.json, open the account, read what it states, and write the entry by hand with the date it was read. Hits marked weak rest on a status code alone. Sites the index does not model can only be noted in an entry's unextracted[] list.</p>
${body}</body></html>`;
  fs.writeFileSync(file, html);
  return file;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  const state = readJson(STATE_PATH, { _comment: "", checked: null, handles: {} });
  state._comment = "What Maigret was asked and what it reported as claimed, per handle, so a pass does not repeat itself inside its max-age window. Written by scripts/pivot-handles-maigret.js. Nothing here is an indicator; a hit is reviewed by a person and, if it holds up, filed by hand in src/_data/iocs/direct-observations.json.";
  const { owners, indexed, found } = collectHandles(opts.emailLocals);

  // Handles a persona actually holds go first; the earlier passes' leftovers
  // that no longer map to a persona come last.
  let handles = opts.handles.length
    ? opts.handles
    // Locale pinned so the tie-break order (and so which handles the --limit
    // cutoff keeps) does not depend on the runtime's default locale.
    : [...owners.entries()].sort((a, b) => (b[1].size - a[1].size) || a[0].localeCompare(b[0], "en")).map(([h]) => h);
  if (!opts.force && !opts.handles.length) {
    const cutoff = Date.now() - opts.maxAgeDays * 86400 * 1000;
    handles = handles.filter((h) => {
      const prev = state.handles[h];
      return !prev || !prev.checked || Date.parse(prev.checked) < cutoff;
    });
  }
  handles = handles.slice(0, opts.limit);
  console.log(`${owners.size} handles in the index; ${handles.length} to check (top ${opts.topSites} sites each).`);

  const outDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "maigret-"));
  const rows = [];
  handles.forEach((handle, i) => {
    process.stdout.write(`  ${i + 1}/${handles.length} ${handle} ... `);
    let result;
    try { result = runMaigret(handle, opts, outDir); } catch (err) { result = { error: err.message }; }
    const hits = (result.hits || []).map((h) => ({
      ...h,
      indexed: Boolean(h.value && indexed.has(String(h.value).toLowerCase())) || found.has(`${handle.toLowerCase()}|${h.ioc_type}`),
    }));
    console.log(result.error ? `failed: ${result.error}` : `${hits.length} claimed`);
    rows.push({ handle, personas: [...(owners.get(handle) || [])], hits, error: result.error || null });
    if (!result.error) {
      state.handles[handle] = {
        checked: today,
        top_sites: opts.topSites,
        claimed: hits.map((h) => ({ site: h.site_name, url: h.url, ...(h.ioc_type ? { ioc_type: h.ioc_type, value: h.value } : {}), ...(h.weak ? { weak: true } : {}) })),
      };
      // Saved after every handle, so a pass that is interrupted keeps what it
      // learned and the next one carries on from there.
      state.checked = today;
      writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    }
  });
  state.checked = today;
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  if (!rows.length) {
    console.log("Nothing to check.");
    return;
  }
  const review = writeReview(rows, today);
  const modelled = rows.reduce((n, r) => n + r.hits.filter((h) => h.ioc_type && !h.indexed).length, 0);
  console.log(`\n${rows.length} handles checked; ${modelled} new hits on platforms the index models.`);
  console.log(`Review: ${review}`);
  console.log(`State:  ${STATE_PATH}`);
}

main();
