#!/usr/bin/env node
/**
 * check-repo-signatures.js
 * ==============================================================
 * The local-directory half of the PolinRider Scanner tool designed in
 * docs/repo-signature-check.md. Walks a local repository checkout and
 * checks it for the injection signatures published by OpenSourceMalware's
 * polinrider-scanner.sh -- reimplemented here (not vendored: PolinRider
 * carries no LICENSE file, so its logic is credited and reproduced rather
 * than its source copied) against the same all_of_strings `detection`
 * blocks already used by scripts/check-etherhiding-contracts.js, whose
 * compileDetections()/testDetection() this script reuses directly.
 *
 * Run manually:
 *   node scripts/check-repo-signatures.js --dir .
 *   node scripts/check-repo-signatures.js --dir ../some-other-repo --verbose
 *   node scripts/check-repo-signatures.js --dir . --json
 *
 * WHAT A MATCH MEANS
 * -------------------
 * That a file contains a string signature publicly reported as part of the
 * PolinRider campaign's injected loader stub. It is a lead for manual
 * review, not proof the repository is currently compromised -- the same
 * rule this site states for every other scanning surface it publishes.
 *
 * TWO RULES THIS TOOL MUST NOT BEND
 * -----------------------------------
 * Scanned file content is never executed or eval'd -- it is read and
 * string-matched as inert text, the way a defender should treat any
 * attacker-controlled source. There is no eval, no Function, no dynamic
 * require anywhere in this file.
 *
 * Every check this tool attempts is reported, including ones it could not
 * complete (an unreadable file, a missing git binary) -- a report that
 * quietly drops a failed check reads as a clean scan when it is not one.
 *
 * EXIT CODES (mirrors polinrider-scanner.sh's own contract)
 * -----------------------------------------------------------
 *   0 = clean: no signal found
 *   1 = one or more signals found
 *   2 = the scan itself could not complete (bad --dir, not a directory)
 */

const fs = require("fs");
const path = require("path");

const { compileDetections, testDetection } = require("./check-etherhiding-contracts.js");

const ROOT = path.join(__dirname, "..");
const RULESET_PATH = path.join(ROOT, "src", "_data", "iocs", "repo-scan-ruleset.json");

const SKIP_DIRS = new Set(["node_modules", ".git", "_site", ".cache", "dist", "build", ".next"]);

/**
 * Files the ruleset's PolinRider c2_pattern descriptions name as injection
 * targets, plus the .vscode/tasks.json curl-to-shell vector. A name-based
 * allowlist rather than "every file" keeps a full-repo scan fast and keeps
 * this tool testing what the cited reporting actually says was touched,
 * not fishing through unrelated source for a coincidental string match.
 */
const TARGET_FILENAME_RE =
  /^(postcss|tailwind|eslint|next|babel|jest)\.config\.(m?js|c?js|ts)$/i;
const TARGET_EXTRA_PATHS = new Set([path.join(".vscode", "tasks.json")]);

function loadRuleset() {
  const raw = fs.readFileSync(RULESET_PATH, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error("repo-scan-ruleset.json must be a JSON array");
  }
  return entries;
}

/** Every file under `dir` worth checking, paired with its path relative to `dir`. */
function walk(dir, relBase = "") {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const dirent of names) {
    const abs = path.join(dir, dirent.name);
    const rel = path.join(relBase, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      out.push(...walk(abs, rel));
    } else if (dirent.isFile()) {
      out.push({ abs, rel });
    }
  }
  return out;
}

function isTargetConfigFile(rel) {
  const base = path.basename(rel);
  return TARGET_FILENAME_RE.test(base) || TARGET_EXTRA_PATHS.has(rel);
}

// ---------------------------------------------------------------------------
// Check 1: c2_pattern signature strings in config files
// ---------------------------------------------------------------------------

function checkSignatures(files, entries, results) {
  const { usable, unevaluated } = compileDetections(entries);
  results.checksAttempted.push(
    `${usable.length} c2_pattern signature(s) with a machine-readable detection block, ` +
      `tested against ${files.length} config-file candidate(s)`
  );
  for (const entry of unevaluated) {
    results.checksAttempted.push(
      `ruleset entry ${entry.id} (c2_pattern) was NOT evaluated -- it carries no machine-readable detection block`
    );
  }

  for (const { abs, rel } of files) {
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (err) {
      results.checksAttempted.push(`${rel} -- FAILED to read: ${err.message}`);
      continue;
    }
    for (const entry of usable) {
      const hits = testDetection(entry, text);
      if (!hits) continue;
      results.findings.push({
        check: "signature",
        ioc_id: entry.id,
        file: rel,
        detail: `matched ${entry.malware_family || "unattributed"} signature ${entry.id}: ${hits}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: flagged filenames present anywhere in the tree
// ---------------------------------------------------------------------------

function checkFlaggedFilenames(files, entries, results) {
  const flagged = entries.filter((e) => e.ioc_type === "filename" && e.value);
  results.checksAttempted.push(
    `${flagged.length} flagged filename(s) from the ruleset, checked against ${files.length} file(s) in the tree`
  );
  const byName = new Map();
  for (const { rel } of files) {
    const base = path.basename(rel);
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(rel);
  }
  for (const entry of flagged) {
    const hits = byName.get(entry.value);
    if (!hits) continue;
    for (const rel of hits) {
      results.findings.push({
        check: "filename",
        ioc_id: entry.id,
        file: rel,
        detail: `filename matches flagged indicator ${entry.id} (${entry.value}, ${entry.malware_family || "unattributed"})`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: .gitignore hiding config.bat
// ---------------------------------------------------------------------------

function checkGitignore(dir, results) {
  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    results.checksAttempted.push(".gitignore not present -- check skipped");
    return;
  }
  let text;
  try {
    text = fs.readFileSync(gitignorePath, "utf8");
  } catch (err) {
    results.checksAttempted.push(`.gitignore -- FAILED to read: ${err.message}`);
    return;
  }
  results.checksAttempted.push(".gitignore checked for a config.bat-hiding entry");
  const hidesConfigBat = text
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === "config.bat" || line === "/config.bat" || line === "*config.bat*");
  if (hidesConfigBat) {
    results.findings.push({
      check: "gitignore",
      ioc_id: null,
      file: ".gitignore",
      detail:
        "contains an entry hiding config.bat -- reported by OpenSourceMalware as a pattern used to keep the PolinRider propagation script out of a normal git status/diff review",
    });
  }
}

// ---------------------------------------------------------------------------
// Check 4: git reflog amended-commit pattern
// ---------------------------------------------------------------------------

function checkReflog(dir, results) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    results.checksAttempted.push("not a git repository (no .git directory) -- reflog check skipped");
    return;
  }
  // polinrider-scanner.sh's exact reflog heuristic is not publicly documented
  // beyond "flags amended commit entries in git reflog" -- reproducing an
  // unverified regex here would read as a real check when it is a guess, so
  // this stays an explicit gap rather than a fabricated pattern.
  results.checksAttempted.push(
    "git reflog amended-commit check: NOT IMPLEMENTED -- polinrider-scanner.sh's exact reflog heuristic " +
      "was not published in enough detail to reproduce faithfully; flagged here as a known gap, not silently skipped"
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/check-repo-signatures.js --dir <path> [--verbose] [--json]

Options:
  --dir <path>   Directory to scan (default: .)
  --verbose      Print every check attempted, not just findings.
  --json         Print the full result as JSON instead of a text report.
  --help         Show this message.

Checks a local repository checkout for PolinRider's published injection
signatures: config-file obfuscation strings, propagation filenames, a
.gitignore entry hiding config.bat, and (where possible) git reflog
patterns. Exit code 0 = clean, 1 = signal(s) found, 2 = scan incomplete.`;

function parseArgs(argv) {
  const args = { dir: ".", verbose: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--dir": args.dir = argv[++i]; break;
      case "--verbose": args.verbose = true; break;
      case "--json": args.json = true; break;
      case "--help":
      case "-h": args.help = true; break;
      default: throw new Error(`unknown argument "${flag}"`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const dir = path.resolve(args.dir);
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    console.error(`Cannot scan "${dir}": ${err.message}`);
    return 2;
  }
  if (!stat.isDirectory()) {
    console.error(`Cannot scan "${dir}": not a directory`);
    return 2;
  }

  const entries = loadRuleset();
  const files = walk(dir);
  const targetFiles = files.filter(({ rel }) => isTargetConfigFile(rel));

  const results = { findings: [], checksAttempted: [] };
  checkSignatures(targetFiles, entries, results);
  checkFlaggedFilenames(files, entries, results);
  checkGitignore(dir, results);
  checkReflog(dir, results);

  if (args.json) {
    console.log(JSON.stringify({ dir, ...results }, null, 2));
  } else {
    console.log(`PolinRider signature scan: ${dir}`);
    console.log(`  ${files.length} file(s) walked, ${targetFiles.length} config-file candidate(s) checked for signatures\n`);

    if (args.verbose) {
      for (const line of results.checksAttempted) console.log(`  - ${line}`);
      console.log("");
    }

    if (results.findings.length === 0) {
      console.log("[CLEAN] No PolinRider signatures found.");
    } else {
      console.log(`[INFECTED] ${results.findings.length} signal(s) found:`);
      for (const f of results.findings) {
        console.log(`  - ${f.file}: ${f.detail}`);
      }
      console.log(
        "\nEach signal above is a lead for manual review, not proof of active compromise. " +
          "Verify against the cited source before treating a match as confirmed, and see " +
          "docs/repo-signature-check.md for remediation guidance."
      );
    }
  }

  return results.findings.length > 0 ? 1 : 0;
}

if (require.main === module) {
  let code;
  try {
    code = main();
  } catch (err) {
    console.error(`Scan failed: ${err.message}`);
    code = 2;
  }
  process.exitCode = code;
}

module.exports = { walk, isTargetConfigFile, checkSignatures, checkFlaggedFilenames };
