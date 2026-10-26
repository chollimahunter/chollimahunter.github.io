#!/usr/bin/env node
/**
 * check-site.js — structural checks over the built site
 * ==========================================================================
 * Runs after `npm run build` and fails the deploy when the output is broken
 * in a way a template change can cause silently: an internal link or asset
 * path that resolves to nothing, an inline style, a page with no or two
 * <h1>s, an id used twice on one page, an image with no alt attribute, or a
 * template variable that rendered as the word "undefined". None of these
 * raise an Eleventy error, which is why the first audit of the site found
 * several of them live. It also fails on an entity escaped twice in a title
 * or meta tag, a link with a scheme other than http(s) or mailto, a sitemap
 * entry with no page behind it, a private page in a production build, and a
 * link to a site the operators run or to an indexed payload URL.
 *
 *   npm run build && npm run check
 *
 * Every HTML file under _site is read, including the ~16,000 indicator
 * pages, which takes about ten seconds. The check knows nothing about the
 * templates; it only reads what they produced.
 */
const fs = require("fs");
const path = require("path");
const { safeDecode } = require("./lib/ioc-normalize.js");
const { isOperatorHost } = require("./lib/operator-hosts.js");

/** Prints the header comment's opening paragraph and exits 0, for --help/-h. */
function printHelp() {
  const m = fs.readFileSync(__filename, "utf8").match(/\/\*\*\r?\n([\s\S]*?)\*\//);
  if (!m) return;
  const lines = m[1].split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, ""));
  let bannerAt = -1;
  for (let j = 0; j < Math.min(lines.length, 6); j++) {
    if (/^=+$/.test(lines[j].trim())) { bannerAt = j; break; }
  }
  let i = bannerAt === -1 ? 0 : bannerAt + 1;
  while (lines[i] !== undefined && !lines[i].trim()) i++;
  const para = [];
  while (lines[i] !== undefined && lines[i].trim()) { para.push(lines[i]); i++; }
  console.log(para.join(" ").replace(/\s+/g, " ").trim());
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const root = path.resolve(__dirname, "..", "_site");
if (!fs.existsSync(root)) {
  console.error("check-site: _site does not exist; run `npm run build` first.");
  process.exit(2);
}

const pages = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".html")) pages.push(full);
  }
})(root);

const problems = [];
const report = (kind, page, detail) => problems.push({ kind, page, detail });

// Pages written only by the dev server or with ELEVENTY_PRIVATE_PAGES set. A
// production build that contains one, links to one or lists one in a sitemap
// would publish it. The private checkout names its own pages.
const privateModule = path.join(__dirname, "..", "_drafts", "private", "eleventy.js");
const PRIVATE_PATHS = ["/remote-workers/held-back/", ...(fs.existsSync(privateModule) ? require(privateModule).PATHS : [])];
const privateAllowed = Boolean(process.env.ELEVENTY_PRIVATE_PAGES);
const isPrivate = (url) => PRIVATE_PATHS.some((p) => url.startsWith(p) || url === p.slice(0, -1));
if (!privateAllowed) {
  for (const p of PRIVATE_PATHS) {
    if (fs.existsSync(path.join(root, p, "index.html"))) {
      report("private-page-built", p, "private page present in a production build");
    }
  }
}

// The hosts the operators run, from the same merged index the build renders,
// so no page links to live infrastructure. See scripts/lib/operator-hosts.js.
const checkIndex = require("../src/_data/iocIndex.js")();
const operatorHosts = new Set(checkIndex.operator_hosts || []);
// A payload URL serves live malware from a shared service, so it is shown as
// text and never as a link. Held lowercased and without its scheme, to be found
// inside an href however the link is built.
const payloadUrls = [
  ...(checkIndex.records || []),
  ...((checkIndex.remote_workers && checkIndex.remote_workers.records) || []),
]
  .filter((r) => r.ioc_type === "payload_url")
  .map((r) => String(r.value).toLowerCase().replace(/^https?:\/\//, ""));
const OPERATOR_EXAMPLES_PER_PAGE = 3;
const DOUBLE_ESCAPED = /&amp;(?:#\d+|#x[0-9a-f]+|amp|quot|lt|gt|apos);/i;
const ANCHOR_HREF = /<a\b[^>]*?\bhref="([^"]*)"/gi;

// Whether a site-absolute URL resolves to a file in the build.
const resolved = new Map();
function exists(url) {
  const clean = safeDecode(url.split("#")[0].split("?")[0]);
  if (!clean) return true;
  if (resolved.has(clean)) return resolved.get(clean);
  const target = path.join(root, clean);
  let ok = false;
  if (fs.existsSync(target)) {
    ok = fs.statSync(target).isFile() || fs.existsSync(path.join(target, "index.html"));
  }
  resolved.set(clean, ok);
  return ok;
}

const LINK = /<(?:a|img|link|script|source)\b[^>]*?\b(?:href|src)="([^"]*)"/gi;
const LEAK = /(?:>|\s)(?:undefined|\[object Object\]|NaN)(?:<|\s)/;

// Fragment links are checked after every page has been read, since the ids a
// page defines are only known once it has been scanned. Same-page fragments
// are resolved against the page itself; cross-page ones against the target.
const idsByPage = new Map();
const fragmentLinks = [];
function pageKey(url) {
  const clean = safeDecode(url.split("#")[0].split("?")[0]);
  return clean.endsWith("/") ? clean + "index.html" : clean;
}

for (const file of pages) {
  const html = fs.readFileSync(file, "utf8");
  const page = "/" + path.relative(root, file).split(path.sep).join("/");

  let operatorLinks = 0;
  for (const m of html.matchAll(ANCHOR_HREF)) {
    const href = m[1].trim();
    if (!/^(?:https?:|mailto:|\/(?!\/)|#)/i.test(href)) report("disallowed-href-scheme", page, href.slice(0, 80));
    const bare = href.split("#")[0].split("?")[0];
    if (!privateAllowed && bare.startsWith("/") && isPrivate(bare)) report("private-page-linked", page, href);
    if (/^https?:/i.test(href) && isOperatorHost(operatorHosts, href.replace(/&amp;/g, "&"))) {
      if (operatorLinks < OPERATOR_EXAMPLES_PER_PAGE) report("operator-site-linked", page, href.slice(0, 120));
      operatorLinks += 1;
    }
  }
  if (payloadUrls.length) {
    let payloadLinks = 0;
    for (const m of html.matchAll(ANCHOR_HREF)) {
      // Only an absolute href can carry another host's URL; a site-relative
      // or fragment link cannot, so skip the scan over every payload for them.
      if (!/^https?:/i.test(m[1].trim())) continue;
      const href = m[1].replace(/&amp;/g, "&").toLowerCase();
      if (payloadUrls.some((p) => href.includes(p))) {
        if (payloadLinks < OPERATOR_EXAMPLES_PER_PAGE) report("payload-url-linked", page, m[1].slice(0, 120));
        payloadLinks += 1;
      }
    }
  }
  if (operatorLinks > OPERATOR_EXAMPLES_PER_PAGE) {
    report("operator-site-linked", page, `... and ${operatorLinks - OPERATOR_EXAMPLES_PER_PAGE} more on this page`);
  }

  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (title && DOUBLE_ESCAPED.test(title[1])) report("double-escaped-entity", page, title[1].trim().slice(0, 100));
  for (const m of html.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"/gi)) {
    if (DOUBLE_ESCAPED.test(m[1])) {
      report("double-escaped-entity", page, m[1].slice(0, 100));
      break;
    }
  }

  let match;
  while ((match = LINK.exec(html))) {
    const url = match[1];
    if (/^(?:https?:|mailto:|tel:|data:)/.test(url)) continue;
    if (url.startsWith("#")) {
      if (url.length > 1) fragmentLinks.push({ page, target: page, fragment: url.slice(1) });
      continue;
    }
    if (!url.startsWith("/")) {
      report("relative-url", page, url);
      continue;
    }
    if (!exists(url)) {
      report("broken-link", page, url);
    } else if (url.includes("#") && !url.endsWith("#")) {
      fragmentLinks.push({ page, target: pageKey(url), fragment: url.split("#")[1] });
    }
  }

  const pageIds = new Set();
  for (const m of html.matchAll(/ (?:id|name)="([^"]+)"/g)) pageIds.add(m[1]);
  idsByPage.set(page, pageIds);

  if (/ style="/.test(html)) report("inline-style", page, "");

  const h1s = (html.match(/<h1\b/g) || []).length;
  if (h1s !== 1) report("h1-count", page, String(h1s));

  const ids = new Set();
  for (const m of html.matchAll(/ id="([^"]+)"/g)) {
    if (ids.has(m[1])) {
      report("duplicate-id", page, m[1]);
      break;
    }
    ids.add(m[1]);
  }

  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/ alt=/.test(m[0])) {
      report("img-without-alt", page, m[0].slice(0, 80));
      break;
    }
  }

  if (/<title>\s*(?:—|<\/title>)/.test(html)) report("empty-title", page, "");

  // A quoted source passage is the source's text, which can contain the word
  // "undefined" (Abstract Security quotes a search query that does); only
  // markup outside the quotes is checked.
  const leak = LEAK.exec(html.replace(/<blockquote class="ioc-result__context">[\s\S]*?<\/blockquote>/g, ""));
  if (leak) report("template-leak", page, leak[0].trim());
}

// A link to a heading that was renamed or removed still resolves to the page,
// so it passes the file check above and silently drops the reader at the top.
const seenFragment = new Set();
for (const { page, target, fragment } of fragmentLinks) {
  const key = page + " -> " + target + "#" + fragment;
  if (seenFragment.has(key)) continue;
  seenFragment.add(key);
  const ids = idsByPage.get(target);
  if (!ids) continue; // not an HTML page (e.g. a JSON download)
  if (!ids.has(safeDecode(fragment))) report("broken-fragment", page, target + "#" + fragment);
}

// The XML files a crawler reads have to parse; a stray ampersand in a title
// is enough to make a sitemap unreadable. sitemap.xml is an index, so every
// file it names is checked too, and each must exist: a child the index
// promises but the build did not write is a fetch error in Search Console.
const xmlFiles = ["sitemap.xml", "feed.xml"];
const indexFile = path.join(root, "sitemap.xml");
if (fs.existsSync(indexFile)) {
  for (const m of fs.readFileSync(indexFile, "utf8").matchAll(/<loc>[^<]*\/([^/<]+\.xml)<\/loc>/g)) {
    xmlFiles.push(m[1]);
  }
}
for (const name of xmlFiles) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) {
    report("missing-file", "/" + name, "");
    continue;
  }
  const xml = fs.readFileSync(file, "utf8");
  if (!xml.startsWith("<?xml")) report("xml-not-at-start", "/" + name, xml.slice(0, 40));
  // A sitemap entry for a page marked noindex is a contradiction Google
  // reports as an error and then ignores; a redirect stub listed by mistake is
  // the usual cause. sitemap.xml is an index of sitemaps and has no <url>.
  for (const m of xml.matchAll(/<url>\s*<loc>https?:\/\/[^/<]+(\/[^<]*)<\/loc>/g)) {
    if (!exists(m[1].replace(/&amp;/g, "&"))) report("sitemap-loc-missing", "/" + name, m[1]);
    if (!privateAllowed && isPrivate(m[1])) report("private-page-in-sitemap", "/" + name, m[1]);
    const target = path.join(root, m[1], "index.html");
    if (fs.existsSync(target) && /name="robots" content="noindex"/.test(fs.readFileSync(target, "utf8"))) {
      report("sitemap-noindex", "/" + name, m[1]);
    }
  }
  const bareAmp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.exec(xml);
  if (bareAmp) report("xml-bare-ampersand", "/" + name, xml.slice(bareAmp.index - 40, bareAmp.index + 40));
}

// The stylesheet is token-driven on purpose: every colour, type size and
// breakpoint is defined once in :root (or the breakpoint comment) so a global
// change is a one-line edit. A literal that creeps in below :root is the start
// of the drift this guards against. Two ambient gradient opacities and the nav
// mask's black stops are the documented exceptions.
const cssFile = path.resolve(__dirname, "..", "src", "assets", "css", "tokens.css");
if (fs.existsSync(cssFile)) {
  const css = fs.readFileSync(cssFile, "utf8");
  const rootEnd = css.indexOf("}", css.indexOf(":root {"));
  const body = css.slice(rootEnd);
  const allowedColours = new Set(["rgba(255, 59, 78, 0.055)", "rgba(255, 59, 78, 0.035)", "#000"]);
  for (const m of body.matchAll(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g)) {
    if (!allowedColours.has(m[0])) report("css-literal-colour", "tokens.css", m[0]);
  }
  const allowedWidths = new Set(["36rem", "47.99rem", "48rem", "64rem", "72rem"]);
  for (const m of body.matchAll(/@media\s*\(\s*(?:min|max)-width:\s*([^)]+)\)/g)) {
    if (!allowedWidths.has(m[1].trim())) report("css-breakpoint", "tokens.css", m[0]);
  }
  for (const m of body.matchAll(/font-size:\s*([^;]+);/g)) {
    const value = m[1].trim();
    if (!/^(?:var\(--|inherit$|[\d.]+em$)/.test(value)) report("css-literal-font-size", "tokens.css", value);
  }
  if (/ style="/.test(body)) report("css-inline-style", "tokens.css", "");
}

const byKind = new Map();
for (const p of problems) {
  if (!byKind.has(p.kind)) byKind.set(p.kind, []);
  byKind.get(p.kind).push(p);
}

console.log(`check-site: ${pages.length} pages checked`);
for (const [kind, list] of byKind) {
  console.log(`\n${kind}: ${list.length}`);
  for (const p of list.slice(0, 10)) console.log(`  ${p.page}${p.detail ? "  " + p.detail : ""}`);
  if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
}

if (problems.length) {
  console.error(`\ncheck-site: ${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("check-site: no problems found.");
