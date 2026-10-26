#!/usr/bin/env node
/**
 * score-copied-repos.js
 * ==========================================================================
 * For each indexed GitHub persona account, finds its non-fork public
 * repositories that look like copies of someone else's repository, and scores
 * how close each copy is. A control set of ordinary accounts goes through the
 * identical code, so the output carries a base rate.
 *
 *   node scripts/score-copied-repos.js [--limit N] [--repos N] [--no-control]
 *                                      [--account login] [--refresh]
 *
 * Origin heuristic (see docs/repo-copy-scores.md): GitHub reports no parent
 * for a non-fork copy, so candidates come from (1) repositories linked by
 * their GitHub URL in the repo's own README, and (2) GitHub code search for the
 * longest distinctive line of the repo's largest source file and for the
 * package.json name. Each candidate is cloned (no checkout, depth 1, in a temp
 * directory deleted afterwards) and compared by git blob hash, which
 * `git ls-tree` yields without reading file contents. Resumable: an account
 * already in the output is skipped unless --refresh. Authenticates through
 * `gh api`; no token is read. Writes scripts/data/repo-copy-scores.json.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { writeFileAtomic } = require("./lib/write-atomic.js");

const OUT = path.join(__dirname, "data", "repo-copy-scores.json");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};
const LIMIT = Number(opt("limit", 0)) || Infinity;
const MAX_REPOS = Number(opt("repos", 25));
const ONLY = opt("account", null);
const REFRESH = argv.includes("--refresh");
const USE_CONTROL = !argv.includes("--no-control");

// Thresholds, documented in docs/repo-copy-scores.md.
const COPY_HASH_SHARE = 0.5; // share of the repo's files with an identical blob in the origin
const COPY_MIN_FILES = 3; // ... and at least this many files
const COPY_LINE_SHARE = 0.8; // or mean line overlap of the top files at least this
const MAX_REPO_KB = 50000;
const TOP_FILES = 5;

// Ordinary accounts: the first five results, in GitHub's default order, of
//   created:2023-03-01..2023-09-30 repos:5..25 followers:0..3 type:user
// run on 2026-10-02. None is in the index.
const CONTROL = ["trwng", "cssupport23", "GooseBooze", "cobra225", "RajaSoundari"];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function gh(args, attempt = 1) {
  try {
    return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = String(e.stderr || e.message);
    if (/rate limit/i.test(err) && attempt < 5) {
      sleep(65000);
      return gh(args, attempt + 1);
    }
    throw new Error(err.trim().split("\n")[0]);
  }
}
const ghJson = (args) => JSON.parse(gh(args));
const git = (cwd, args, enc = "utf8") =>
  execFileSync("git", args, { cwd, encoding: enc, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

function personaLogins() {
  const removed = new Set(
    ((JSON.parse(fs.readFileSync(path.join(__dirname, "data", "github-account-status.json"), "utf8")).accounts) || [])
      .filter((a) => a.state === "removed").map((a) => a.login.toLowerCase())
  );
  const seen = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "github_profile") continue;
    const m = String(r.value).match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})$/);
    if (m && !removed.has(m[1].toLowerCase())) seen.add(m[1].toLowerCase());
  }
  return [...seen].sort();
}

const TRIVIAL = /(^|\/)(license[^/]*|\.gitignore|\.gitattributes|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store)$/i;
const SOURCE = /\.(js|ts|jsx|tsx|py|go|rs|java|c|cc|cpp|h|cs|rb|php|sol|vue|kt|swift|md)$/i;

function listTree(dir) {
  return git(dir, ["ls-tree", "-r", "-l", "HEAD"])
    .split("\n").filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.*)$/);
      return m && m[2] === "blob" ? { hash: m[3], size: m[4] === "-" ? 0 : Number(m[4]), path: m[5] } : null;
    })
    .filter((f) => f && f.size > 0 && !TRIVIAL.test(f.path));
}
const blob = (dir, hash) => git(dir, ["cat-file", "blob", hash]);

function clone(fullName, root) {
  const dir = fs.mkdtempSync(path.join(root, "r-"));
  git(dir, ["init", "-q"]);
  git(dir, ["fetch", "-q", "--depth", "1", `https://github.com/${fullName}.git`, "HEAD"]);
  git(dir, ["update-ref", "HEAD", "FETCH_HEAD"]);
  return dir;
}

function distinctiveLine(dir, files) {
  const cands = files.filter((f) => SOURCE.test(f.path) && f.size < 200000).sort((a, b) => b.size - a.size).slice(0, 3);
  let best = "";
  for (const f of cands) {
    for (const raw of blob(dir, f.hash).split("\n")) {
      const line = raw.trim();
      if (line.length < 40 || line.length > 120 || /^(\/\/|#|\*|\/\*|import |from |require)/.test(line)) continue;
      if (/["`\\]/.test(line)) continue; // quotes and backslashes break search syntax
      if (line.length > best.length) best = line;
    }
  }
  return best;
}

function candidatesFor(owner, repo, dir, files) {
  const found = new Map(); // fullName -> signals
  const add = (full, why) => {
    if (!full || full.split("/")[0].toLowerCase() === owner.toLowerCase()) return;
    const k = full.toLowerCase();
    const e = found.get(k) || { full, why: new Set() };
    e.why.add(why);
    found.set(k, e);
  };
  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f.path));
  if (readme) {
    for (const m of blob(dir, readme.hash).matchAll(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g)) {
      add(`${m[1]}/${m[2].replace(/\.git$/, "")}`, "readme-url");
    }
  }
  const searches = [];
  const line = distinctiveLine(dir, files);
  if (line) searches.push([`"${line}"`, "code-line"]);
  const pkg = files.find((f) => f.path === "package.json");
  if (pkg) {
    try {
      const name = JSON.parse(blob(dir, pkg.hash)).name;
      if (name && name.length > 6) searches.push([`"\\"name\\": \\"${name}\\"" filename:package.json`, "pkg-name"]);
    } catch { /* not JSON */ }
  }
  for (const [q, why] of searches) {
    try {
      sleep(7000); // code search allows about 9 requests a minute
      const r = ghJson(["-X", "GET", "search/code", "-f", `q=${q} -user:${owner}`, "-f", "per_page=10"]);
      for (const it of r.items || []) add(it.repository.full_name, why);
    } catch (e) { /* a failed search just yields no candidates */ }
  }
  return [...found.values()]
    .sort((a, b) => b.why.size - a.why.size)
    .slice(0, 3);
}

function score(dirA, filesA, dirB, filesB) {
  const hashes = new Set(filesB.map((f) => f.hash));
  const byPath = new Map(filesB.map((f) => [f.path, f]));
  const matched = filesA.filter((f) => hashes.has(f.hash)).length;
  const top = filesA.filter((f) => SOURCE.test(f.path) && f.size < 300000).sort((a, b) => b.size - a.size).slice(0, TOP_FILES);
  const shares = [];
  for (const f of top) {
    const lines = blob(dirA, f.hash).split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
    if (!lines.length) continue;
    const same = byPath.get(f.path) || filesB.find((g) => path.basename(g.path) === path.basename(f.path) && g.size > 0);
    if (!same) { shares.push(0); continue; }
    const set = new Set(blob(dirB, same.hash).split("\n").map((l) => l.trim()));
    shares.push(lines.filter((l) => set.has(l)).length / lines.length);
  }
  return {
    files: filesA.length,
    identical_files: matched,
    hash_share: Number((matched / Math.max(1, filesA.length)).toFixed(3)),
    line_share: shares.length ? Number((shares.reduce((a, b) => a + b, 0) / shares.length).toFixed(3)) : 0,
  };
}

function checkAccount(login, root) {
  const repos = ghJson(["-X", "GET", `users/${login}/repos`, "-f", "type=owner", "-f", "sort=pushed", "-f", "per_page=100"])
    .filter((r) => !r.fork && r.size > 0 && r.size < MAX_REPO_KB)
    .slice(0, MAX_REPOS);
  const rec = { login, checked_at: new Date().toISOString().slice(0, 10), repos_checked: 0, repos_unreadable: 0, copies: [], best_scores: [] };
  for (const r of repos) {
    let dirA;
    try {
      dirA = clone(r.full_name, root);
      const filesA = listTree(dirA);
      if (filesA.length < 2) continue;
      rec.repos_checked += 1;
      let best = null;
      for (const c of candidatesFor(login, r.name, dirA, filesA)) {
        let dirB;
        try {
          dirB = clone(c.full, root);
          const s = score(dirA, filesA, dirB, listTree(dirB));
          const rank = Math.max(s.hash_share, s.line_share);
          if (!best || rank > best.rank) best = { rank, origin: c.full, found_by: [...c.why].sort(), ...s };
        } catch { /* origin unreadable */ } finally {
          if (dirB) fs.rmSync(dirB, { recursive: true, force: true });
        }
      }
      if (best) {
        const { rank, ...rest } = best;
        rec.best_scores.push({ repo: r.name, ...rest });
        if ((rest.hash_share >= COPY_HASH_SHARE && rest.identical_files >= COPY_MIN_FILES) || rest.line_share >= COPY_LINE_SHARE) {
          rec.copies.push({ repo: r.name, origin: rest.origin, found_by: rest.found_by, hash_share: rest.hash_share, line_share: rest.line_share, identical_files: rest.identical_files, files: rest.files });
        }
      }
    } catch { rec.repos_unreadable += 1; } finally {
      if (dirA) fs.rmSync(dirA, { recursive: true, force: true });
    }
  }
  rec.best_scores = rec.best_scores.sort((a, b) => b.hash_share - a.hash_share).slice(0, 5);
  return rec;
}

const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {}, control: {} };
const save = () => {
  data._comment =
    "Likely copied repositories among the indexed GitHub accounts, from scripts/score-copied-repos.js, with a control set of " +
    "ordinary accounts run through the same code. A flag is a similarity measurement, not attribution. See docs/repo-copy-scores.md.";
  data.thresholds = { hash_share: COPY_HASH_SHARE, min_identical_files: COPY_MIN_FILES, line_share: COPY_LINE_SHARE };
  data.control_logins = CONTROL;
  const sorted = { ...data, accounts: Object.fromEntries(Object.entries(data.accounts).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileAtomic(OUT, JSON.stringify(sorted, null, 2) + "\n");
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-copy-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));

function run(logins, bucket, label) {
  let n = 0;
  for (const login of logins) {
    if (n >= LIMIT) break;
    const key = login.toLowerCase();
    // An "error: ..." entry records a failed attempt, not a result, so it is retried.
    if (!REFRESH && bucket[key] && !String(bucket[key].status || "").startsWith("error")) continue;
    try {
      bucket[key] = checkAccount(login, root);
    } catch (e) {
      bucket[key] = { login, checked_at: new Date().toISOString().slice(0, 10), status: "error: " + e.message.slice(0, 120) };
    }
    n += 1;
    const b = bucket[key];
    console.log(`${label} ${login}: ${b.status || `${b.repos_checked} repos, ${b.copies.length} flagged`}`);
    save();
  }
}

const targets = ONLY ? [ONLY] : personaLogins();
run(targets, data.accounts, "persona");
if (USE_CONTROL && !ONLY) run(CONTROL, (data.control = data.control || {}), "control");
save();

const summ = (b) => {
  const v = Object.values(b).filter((a) => !a.status);
  const repos = v.reduce((s, a) => s + a.repos_checked, 0);
  const flagged = v.reduce((s, a) => s + a.copies.length, 0);
  return `${v.length} accounts, ${repos} repos checked, ${flagged} flagged (${repos ? ((100 * flagged) / repos).toFixed(1) : "0"}%)`;
};
console.log("personas: " + summ(data.accounts));
console.log("control:  " + summ(data.control || {}));
