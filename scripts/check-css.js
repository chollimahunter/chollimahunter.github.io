#!/usr/bin/env node
/**
 * check-css.js — keep src/assets/css/tokens.css the single, duplicate-free stylesheet
 * ==========================================================================
 * Runs over the sources, before or after a build, and fails when the CSS and
 * the markup have drifted apart in a way that no build step reports: a
 * selector list declared twice in the same at-rule context of tokens.css (a
 * plain rule and the same selector inside @media are different contexts and
 * are allowed), a class used in src/**\/*.njk, *.md, *.html or
 * src/assets/js/*.js that no rule in tokens.css defines, a style= attribute in
 * a template, and a hex colour literal outside a :root block. A class defined
 * but used nowhere is only a warning. Exits 1 with one line per finding.
 *
 *   npm run check:css
 *
 * Two escape hatches, both explicit. A class that is added by something the
 * scan cannot see is named in a marker comment in the file that uses it:
 * `{# css-allow: name #}` in a template, `// css-allow: name` in a script.
 * A hex literal that has to stay (a print rule, a mask) carries a
 * `/* css-allow *\/` comment on its own line in tokens.css. A class written as
 * `badge--{{ kind }}` or `"badge--" + kind` is read as the prefix `badge--`
 * and counts as defined when any rule in tokens.css starts with it.
 */
"use strict";
const fs = require("fs");
const path = require("path");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  const start = lines.findIndex((l) => /^=+$/.test(l.trim())) + 1;
  const para = [];
  for (let i = start; lines[i] !== undefined && lines[i].trim(); i++) para.push(lines[i]);
  console.log(para.join(" ").replace(/\s+/g, " ").trim());
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..");
const CSS_FILE = "src/assets/css/tokens.css";
const PLACEHOLDER = "\u0001";

const findings = [];
const warnings = [];
const fail = (where, msg) => findings.push(`check-css: ${where}: ${msg}`);

// --- File discovery --------------------------------------------------------

function walk(dir, accept, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const read = (p) => fs.readFileSync(p, "utf8");

const srcDir = path.join(ROOT, "src");
const templates = walk(srcDir, (f) => /\.(njk|md|html)$/.test(f) && !f.includes(`${path.sep}_data${path.sep}iocs${path.sep}`));
const scripts = walk(path.join(srcDir, "assets", "js"), (f) => f.endsWith(".js"));

// Replaces a matched span with blanks (or a replacement) keeping its newlines,
// so the line numbers of everything after it stay true.
const keepLines = (m, lead) => lead + m.replace(/[^\n]/g, (c) => (c === "\n" ? "\n" : "")).replace(/^/, "");
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

// --- tokens.css: parse into rules, find duplicates and hex literals -----------

const cssRaw = read(path.join(ROOT, CSS_FILE));
const cssClean = cssRaw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const cssRawLines = cssRaw.split("\n");

const OPAQUE_AT = /^@(font-face|keyframes|-webkit-keyframes|page|property|counter-style|font-feature-values)\b/;
const CONTEXT_AT = /^@(media|supports|layer|container)\b/;

const rules = []; // { context, selectors, line, start, end, opaque }
(function parse() {
  const stack = [];
  let buf = "";
  let bufStart = 0;
  for (let i = 0; i < cssClean.length; i++) {
    const c = cssClean[i];
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < cssClean.length && cssClean[j] !== q) j += cssClean[j] === "\\" ? 2 : 1;
      buf += cssClean.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "{") {
      const prelude = buf.replace(/\s+/g, " ").trim();
      const parent = stack[stack.length - 1];
      let kind;
      if (parent && parent.kind === "opaque") kind = "opaque";
      else if (CONTEXT_AT.test(prelude)) kind = "context";
      else if (OPAQUE_AT.test(prelude)) kind = "opaque";
      else kind = "rule";
      const context = stack.filter((f) => f.kind === "context").map((f) => f.prelude).join(" > ");
      stack.push({ prelude, kind, context, start: i + 1, line: lineOf(cssClean, bufStart + (buf.length - buf.trimStart().length)) });
      buf = "";
    } else if (c === "}") {
      const frame = stack.pop();
      if (frame) rules.push({ ...frame, end: i });
      buf = "";
    } else if (c === ";" && (!stack.length || stack[stack.length - 1].kind === "context")) {
      buf = "";
    } else {
      if (!buf.trim()) bufStart = i;
      buf += c;
      continue;
    }
    bufStart = i + 1;
  }
})();

const styleRules = rules.filter((r) => r.kind === "rule" && !r.prelude.startsWith("@"));
const splitSelectors = (prelude) => prelude.split(",").map((s) => s.trim()).filter(Boolean);

// 1. A selector list declared twice in the same context.
const firstSeen = new Map();
for (const r of styleRules.slice().sort((a, b) => a.line - b.line)) {
  const key = `${r.context}\u0000${splitSelectors(r.prelude).sort().join(", ")}`;
  if (firstSeen.has(key)) {
    const where = r.context ? ` inside ${r.context}` : "";
    fail(`${CSS_FILE}:${r.line}`, `selector "${r.prelude}" is declared again${where} (first at line ${firstSeen.get(key)})`);
  } else {
    firstSeen.set(key, r.line);
  }
}

// 2. Hex colours outside a :root block.
const isRootBlock = (r) => splitSelectors(r.prelude).every((s) => s.startsWith(":root"));
for (const r of rules) {
  if (r.kind === "context" || (r.kind === "rule" && isRootBlock(r)) || /^@font-face/.test(r.prelude)) continue;
  const body = cssClean.slice(r.start, r.end);
  const re = /#[0-9a-fA-F]{3,8}\b/g;
  let m;
  while ((m = re.exec(body))) {
    const line = lineOf(cssClean, r.start + m.index);
    if (/css-allow/.test(cssRawLines[line - 1])) continue;
    fail(`${CSS_FILE}:${line}`, `hex colour ${m[0]} outside :root; use a token, or mark the line with /* css-allow */`);
  }
}

// --- Classes defined in tokens.css --------------------------------------------

const defined = new Set();
for (const r of styleRules) {
  for (const m of r.prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
}
const definedList = Array.from(defined);

// --- Classes used by templates and scripts ------------------------------------

const used = []; // { file, line, token }
const allowed = new Map(); // file -> Set of names
const patterns = []; // regexes from template-interpolated or prefix tokens, for the unused warning

function allowMarkers(file, text) {
  for (const m of text.matchAll(/css-allow:([^\n]*)/g)) {
    const names = m[1].split(/#\}|-->|\*\//)[0].split(/[\s,]+/).filter((n) => /^[\w-]+$/.test(n));
    if (!allowed.has(file)) allowed.set(file, new Set());
    for (const n of names) allowed.get(file).add(n);
  }
}

function addClassList(file, line, value, jsPrefixes) {
  for (const token of value.split(/\s+/)) {
    if (!token || token === PLACEHOLDER) continue;
    used.push({ file, line, token, prefix: jsPrefixes && token.endsWith("-") });
  }
}

function scanTemplate(file) {
  const raw = read(file);
  const name = rel(file);
  allowMarkers(name, raw);
  const text = raw
    .replace(/\{#[\s\S]*?#\}/g, (m) => keepLines(m, ""))
    .replace(/<!--[\s\S]*?-->/g, (m) => keepLines(m, ""))
    .replace(/\{\{[\s\S]*?\}\}/g, (m) => keepLines(m, PLACEHOLDER))
    .replace(/\{%[\s\S]*?%\}/g, (m) => keepLines(m, " "));
  for (const m of text.matchAll(/(?<![\w-])class\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    addClassList(name, lineOf(text, m.index), m[1] !== undefined ? m[1] : m[2], false);
  }
  for (const m of text.matchAll(/<[a-zA-Z][^<>]*?\sstyle\s*=/g)) {
    fail(`${name}:${lineOf(text, m.index)}`, "style= attribute; use a class from tokens.css or add one");
  }
}

const JS_STR = "(?:\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)";
const unquote = (lit) => lit.slice(1, -1).replace(/\$\{[^}]*\}/g, PLACEHOLDER).replace(/\\(["'`\\])/g, "$1");

function scanScript(file) {
  const raw = read(file);
  const name = rel(file);
  allowMarkers(name, raw);
  const text = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => keepLines(m, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead);
  for (const m of text.matchAll(new RegExp(`classList\\.(add|toggle)\\(\\s*(${JS_STR}(?:\\s*,\\s*${JS_STR})*)`, "g"))) {
    const literals = m[2].match(new RegExp(JS_STR, "g")) || [];
    const take = m[1] === "toggle" ? literals.slice(0, 1) : literals;
    for (const lit of take) addClassList(name, lineOf(text, m.index), unquote(lit), true);
  }
  for (const m of text.matchAll(new RegExp(`\\.className\\s*\\+?=\\s*(${JS_STR})`, "g"))) {
    addClassList(name, lineOf(text, m.index), unquote(m[1]), true);
  }
  for (const m of text.matchAll(new RegExp(`setAttribute\\(\\s*["']class["']\\s*,\\s*(${JS_STR})`, "g"))) {
    addClassList(name, lineOf(text, m.index), unquote(m[1]), true);
  }
  for (const m of text.matchAll(/(?<![\w-])class\s*=\s*\\?(?:"([^"\\]*)|'([^'\\]*))/g)) {
    addClassList(name, lineOf(text, m.index), (m[1] !== undefined ? m[1] : m[2]).replace(/\$\{[^}]*\}/g, PLACEHOLDER), true);
  }
}

templates.forEach(scanTemplate);
scripts.forEach(scanScript);

const patternOf = (token, prefix) => {
  const body = token.split(PLACEHOLDER).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${prefix ? ".*" : ""}$`);
};

// 3. A class used but not defined.
const reported = new Set();
for (const u of used) {
  const exact = !u.prefix && !u.token.includes(PLACEHOLDER);
  const ok = exact ? defined.has(u.token) : definedList.some((c) => patternOf(u.token, u.prefix).test(c));
  if (ok) continue;
  const allow = allowed.get(u.file);
  if (allow && allow.has(u.token.replace(new RegExp(PLACEHOLDER, "g"), ""))) continue;
  const key = `${u.file}\u0000${u.token}`;
  if (reported.has(key)) continue;
  reported.add(key);
  const shown = u.token.replace(new RegExp(PLACEHOLDER, "g"), "{{...}}");
  fail(`${u.file}:${u.line}`, `class "${shown}" is used but no rule in ${CSS_FILE} defines it (define it, or add a css-allow marker naming it)`);
}

// 4. Warn on a class defined but used nowhere in the sources.
const haystackFiles = [
  ...walk(srcDir, (f) => /\.(njk|md|html|js|json)$/.test(f) && !/[\\/]_data[\\/](iocs|profiles)[\\/]/.test(f) && !/[\\/]profiles[\\/]/.test(f)),
  path.join(ROOT, ".eleventy.js"),
];
const haystack = haystackFiles.map(read).join("\n");
for (const name of definedList.sort()) {
  const re = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
  if (re.test(haystack)) continue;
  if (used.some((u) => (u.prefix || u.token.includes(PLACEHOLDER)) && patternOf(u.token, u.prefix).test(name))) continue;
  warnings.push(`check-css: ${CSS_FILE}: class ".${name}" is defined but used nowhere in src/`);
}

// --- Report -------------------------------------------------------------------

console.log(`check-css: ${styleRules.length} rules, ${defined.size} classes defined, ${templates.length} templates and ${scripts.length} scripts read.`);
if (warnings.length) {
  console.error(`\ncheck-css: ${warnings.length} warning(s), not failing:\n`);
  for (const w of warnings) console.error("  " + w);
}
if (findings.length) {
  console.error(`\ncheck-css: ${findings.length} finding(s):\n`);
  for (const f of findings) console.error("  " + f);
  process.exit(1);
}
console.log("check-css: clean.");
