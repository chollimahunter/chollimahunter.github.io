# repo-signature-check — PolinRider local signature scanner (design)

## Status

Implemented as `scripts/check-repo-signatures.js`. Like the EtherHiding
checker, this is an **on-demand, human-run checking aid**, not a wired-up
automated pipeline: nothing runs it on a schedule, and it writes no findings
file -- output is print-only, to the terminal. The site owner runs it
manually against a local checkout whenever they want to check a repository
for PolinRider's published injection signatures.

## Running it

```
node scripts/check-repo-signatures.js --dir .                    # scan the current directory
node scripts/check-repo-signatures.js --dir ../some-repo          # scan another checkout
node scripts/check-repo-signatures.js --dir . --verbose           # list every check attempted, not just findings
node scripts/check-repo-signatures.js --dir . --json              # machine-readable output
```

| Flag | Effect |
|---|---|
| `--dir <path>` | Directory to scan. Defaults to `.`. |
| `--verbose` | Print every check attempted, not just findings. |
| `--json` | Print the full result as JSON instead of a text report. |

Exit codes mirror `polinrider-scanner.sh`'s own contract: `0` = clean, `1` =
one or more signals found, `2` = the scan itself could not complete (a bad
`--dir`, or the path isn't a directory).

This script reuses `compileDetections()`/`testDetection()` directly from
`scripts/check-etherhiding-contracts.js` rather than reimplementing string
matching a second time -- the `all_of_strings` detection-block format is the
same one already defined for `etherhiding-watchlist.json`'s `c2_pattern`
entries, and `repo-scan-ruleset.json`'s PolinRider `c2_pattern` entries carry
the same kind of block.

## Purpose

Check a local repository checkout for the injection signatures OpenSourceMalware
published for the PolinRider campaign: obfuscated loader-stub strings injected
into config files (`postcss.config.mjs`, `tailwind.config.js`, `eslint.config.mjs`,
`next.config.mjs`, `babel.config.js`, `jest.config.js`, and `.vscode/tasks.json`),
propagation filenames (`temp_auto_push.bat`, `config.bat`), and a `.gitignore`
entry that hides `config.bat` from a normal review.

Like every other scanning surface this site publishes: **a match is a lead
for manual review, not proof of active compromise.** A string signature
appearing in a config file means the file has been tampered with in a way
consistent with PolinRider's reported technique -- it does not by itself
establish who did it, when, or whether the payload is still live.

## What this tool checks, and what it credits

Every check reproduces logic OpenSourceMalware published for
`polinrider-scanner.sh`, credited by name rather than vendored verbatim --
the PolinRider repository carries no LICENSE file, so its published *logic*
is reimplemented here with attribution instead of its source being copied.

1. **Config-file obfuscation signatures.** Scans files matching
   `{postcss,tailwind,eslint,next,babel,jest}.config.{js,mjs,cjs,ts}` and
   `.vscode/tasks.json` against every `c2_pattern` entry in
   `repo-scan-ruleset.json` that carries a `detection` block -- currently the
   v1 (`rmcej%otb%`) and v2 (`Cot%3t=shtP`) PolinRider obfuscator variants.
2. **Flagged filenames.** Checks the whole tree (excluding `node_modules`,
   `.git`, and common build-output directories) for any filename matching a
   `filename`-type entry in the ruleset.
3. **`.gitignore` inspection.** Flags a `.gitignore` entry that hides
   `config.bat` from a normal `git status`/diff review.
4. **Git reflog.** `polinrider-scanner.sh` also flags amended-commit patterns
   in `git reflog`, used to rewrite history after an injection. That exact
   heuristic was not published in enough detail to reproduce faithfully, so
   this check is reported as an explicit, known gap rather than a guessed
   regex standing in for a real check.

## The `github_search: false` opt-out, and why this tool ignores it

Some ruleset entries carry `"github_search": false`: a value too generic to
search on GitHub's global code index without drowning in unrelated
repositories -- a bare extension (`.npl`), a common batch filename
(`config.bat`), a real system-daemon name (`systemd-resolved`), a short common
word that also names an unrelated product (`viam`), or a path whose derived
query is broken rather than merely broad (`vendor/run-update.sh` and its
siblings, where `derive()` in `scripts/run-repo-scan.js` splits the value on
`/` as if it were a multi-value list and turns it into a `filename:vendor`
query alongside the real one). A reviewer sets the flag once a live
`gh api search/code` query for the value's derived form returns upward of 500
repositories -- past that point a match is noise, not a lead -- and records
the measured count and date in a sibling `github_search_note` field.

That flag means only one thing: `derive()` in `scripts/run-repo-scan.js`
skips deriving a query for the entry, so a *remote* GitHub scan never sends
it. `scripts/check-repo-signatures.js` does not read the flag at all, and
`checkFlaggedFilenames()` runs every `filename`-type entry in the ruleset
against the local tree regardless of it. That is deliberate, not an
oversight: the two tools are searching different things. A GitHub code-search
query for `filename:vendor` is generic because it is evaluated against every
public repository GitHub indexes; the same filename check against one local
checkout has nothing else to be generic *relative to* -- a file named
`config.bat` inside the directory being scanned is exactly as meaningful a
signal whether or not `config.bat` would also flood a global search. The
`c2_pattern` entries this tool evaluates were never candidates for the flag
in the first place: `derive()` treats `c2_pattern` as not GitHub-searchable
regardless, so nothing about the remote-search opt-out applies to them.

## Inputs

- **Ruleset**: `src/_data/iocs/repo-scan-ruleset.json`, read fresh on every
  run -- both the `c2_pattern` entries with `detection` blocks and the
  `filename` entries.
- **Target directory**: supplied by the site owner via `--dir`, defaulting to
  the current directory.

## Constraints / non-goals

- **Never executes scanned file content.** Every file is read and
  string-matched as inert text.
- **Never fabricates a signature.** The git-reflog check documents itself as
  unimplemented rather than approximating a pattern that was never publicly
  detailed.
- **Print-only.** Unlike the EtherHiding checker, this tool writes no
  findings file and has no corresponding results section -- the scan results on
  `/repo-scanner/` stay scoped to the GitHub-remote-search mode documented in
  `docs/repo-scanner-github-scan.md`.
