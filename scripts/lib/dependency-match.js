// dependency-match.js
// ============================================================================
// Exact-dependency verification for repo-scanner package rules. GitHub code
// search matches substrings, so a search for the npm package "config-log"
// also returns every project that depends on "eslint-config-log-level".
// These functions decide, from a matched file's text, whether the package
// named by a rule is really declared there as a dependency. The text is only
// parsed as data; nothing in it is executed or installed.
// ============================================================================

const NPM_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Splits https://github.com/o/r/blob/<ref>/<path> into its parts, or null. */
function parseBlobUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(String(url || ""));
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], path: m[4] };
}

function hasOwn(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** v1 lockfiles nest installed packages under dependencies.<name>.dependencies. */
function lockV1Has(deps, name) {
  if (deps === null || typeof deps !== "object") return false;
  if (hasOwn(deps, name)) return true;
  return Object.values(deps).some((d) => d && typeof d === "object" && lockV1Has(d.dependencies, name));
}

function jsonDeclaresNpm(doc, name) {
  if (doc === null || typeof doc !== "object") return false;
  for (const field of NPM_DEPENDENCY_FIELDS) {
    if (field !== "dependencies" && hasOwn(doc[field], name)) return true;
  }
  // package.json "dependencies" is a flat name -> range map; a v1 lockfile's is
  // a name -> object map that can nest. lockV1Has covers both.
  if (lockV1Has(doc.dependencies, name)) return true;
  if (doc.packages && typeof doc.packages === "object") {
    const needle = `node_modules/${name}`;
    for (const key of Object.keys(doc.packages)) {
      if (key === needle || key.endsWith(`/${needle}`)) return true;
    }
    const root = doc.packages[""];
    if (root && NPM_DEPENDENCY_FIELDS.some((f) => hasOwn(root[f], name))) return true;
  }
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the text of a package.json, package-lock.json or a variant of
 * either (a .backup copy, a template) declares `name` as a dependency. A
 * scoped name only matches itself, so "@google-cloud/logging-winston" never
 * satisfies a rule for "logging-winston". Text that is not valid JSON falls
 * back to a quoted-key test, which still requires the whole name between
 * quotes and so cannot match a longer package.
 */
function hasNpmDependency(text, name) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    const n = escapeRegex(name);
    return new RegExp(`"${n}"\\s*:|"node_modules/${n}"|/node_modules/${n}"`).test(text);
  }
  return jsonDeclaresNpm(doc, name);
}

/** PEP 503 name normalisation: case-insensitive, runs of - _ . equal. */
function normalizePypiName(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** The project name of one requirement string ("Foo_Bar[extra]>=1; marker"), or null. */
function requirementName(spec) {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(?:$|[=<>!~;@(,\s])/.exec(spec);
  return m ? normalizePypiName(m[1]) : null;
}

function requirementsTxtHas(text, want) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(raw);
    if (egg && normalizePypiName(egg[1]) === want) return true;
    if (line.startsWith("-")) continue; // -r, -e, --index-url and other options
    if (requirementName(line) === want) return true;
  }
  return false;
}

function pyprojectHas(text, want) {
  // PEP 621 and PEP 735 dependency arrays hold quoted requirement strings; any
  // quoted string that is itself a requirement for the package counts.
  // A plain `key = "value"` line (name, version, a poetry constraint) is not an
  // array element, so only other lines are scanned.
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[A-Za-z0-9_."-]+\s*=\s*["']/.test(line)) continue;
    for (const m of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      if (requirementName(m[1] ?? m[2]) === want) return true;
    }
  }
  // Poetry declares dependencies as keys of a table: name = "^1.0".
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inDeps = /(^|\.)(dependencies|dev-dependencies)$|\.group\.[^.]+\.dependencies$/.test(table[1]);
      continue;
    }
    if (!inDeps) continue;
    const key = /^"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line);
    if (key && normalizePypiName(key[1]) === want) return true;
  }
  return false;
}

/** True when a requirements.txt or pyproject.toml (by path) declares the package. */
function hasPypiDependency(text, name, filePath = "requirements.txt") {
  const want = normalizePypiName(name);
  const base = String(filePath).split("/").pop().toLowerCase();
  if (base.includes("pyproject") || base.endsWith(".toml")) return pyprojectHas(text, want);
  return requirementsTxtHas(text, want);
}

/** Dispatches on the rule's ioc_type. Returns null for a non-package rule. */
function declaresPackage(iocType, name, text, filePath) {
  if (iocType === "npm_package") return hasNpmDependency(text, name);
  if (iocType === "pypi_package") return hasPypiDependency(text, name, filePath);
  return null;
}

module.exports = { parseBlobUrl, hasNpmDependency, hasPypiDependency, normalizePypiName, requirementName, declaresPackage };
