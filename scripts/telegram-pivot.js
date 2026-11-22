#!/usr/bin/env node
/**
 * telegram-pivot.js
 * ==========================================================================
 * Reads the public t.me page of every indexed Telegram account and lists the
 * contact values its name and bio give that the index does not hold yet.
 *
 * A Telegram bio is where an operator often points at the next channel: on 22
 * November 2026 t.me/greenfoxfun, named in a KGJ organisation's README, gave
 * "GreenFox pumpfun: https://x.com/greenfoxworld" as its bio. The public page
 * at https://t.me/<handle> carries the display name and bio without signing
 * in, so this needs no account and no key.
 *
 *   node scripts/telegram-pivot.js collect [--limit N] [--force] [--extra FILE]
 *   node scripts/telegram-pivot.js rank [--all]
 *
 * `collect` reads each indexed telegram_account (and any further t.me URLs
 * listed one per line in --extra, such as new ones from gh-contact-pivot.js),
 * one request a second, and records title, bio and whether the page shows an
 * account at all, in _drafts/private/telegram-pivot.json. `rank` extracts
 * platform accounts, LinkedIn profiles, email addresses and @mentions from
 * the bios and prints those the index lacks. Nothing is filed automatically.
 */
"use strict";

const fs = require("fs");
const { writeFileAtomic } = require("./lib/write-atomic.js");
const norm = require("./lib/ioc-normalize.js");

const OUT = require("./lib/private-data.js").privatePath("telegram-pivot.json");
const GAP_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();

function handleOf(url) {
  const m = String(url).match(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i);
  return m ? m[1] : null;
}

function targets(extraFile) {
  const out = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) {
    if (r.ioc_type !== "telegram_account") continue;
    const h = handleOf(r.value);
    if (h) out.add(h);
  }
  if (extraFile) for (const line of fs.readFileSync(extraFile, "utf8").split(/\r?\n/)) {
    const h = handleOf(line.trim());
    if (h) out.add(h);
  }
  return [...out];
}

async function read(handle) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://t.me/${handle}`, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow" });
      if (res.status === 429) { await sleep(30000); continue; }
      const html = await res.text();
      const pick = (cls) => {
        const m = html.match(new RegExp(`<div class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</div>`));
        return m ? decode(m[1]) : null;
      };
      const title = pick("tgme_page_title");
      return {
        status: res.status,
        // A handle nobody holds still serves the page, with no title block.
        exists: !!title,
        title,
        // An account with no bio shows Telegram's stock "If you have Telegram" line.
        bio: /^If you have Telegram, you can contact/.test(pick("tgme_page_description") || "") ? null : pick("tgme_page_description"),
        extra: pick("tgme_page_extra"),
      };
    } catch (e) {
      await sleep(5000);
    }
  }
  return null;
}

async function collect(args) {
  const force = args.includes("--force");
  const li = args.indexOf("--limit");
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const ei = args.indexOf("--extra");
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {} };
  let todo = targets(ei >= 0 ? args[ei + 1] : null);
  if (!force) todo = todo.filter((h) => !data.accounts[h.toLowerCase()]);
  todo = todo.slice(0, limit);
  console.log(`${todo.length} Telegram account(s) to read`);
  let n = 0;
  for (const handle of todo) {
    const r = await read(handle);
    if (r) {
      data.accounts[handle.toLowerCase()] = { handle, checked_at: new Date().toISOString().slice(0, 10), ...r };
      writeFileAtomic(OUT, JSON.stringify(data, null, 1) + "\n");
      if (r.bio) console.log(`${handle}: ${r.bio.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (++n % 50 === 0) console.log(`  ${n}/${todo.length}`);
    await sleep(GAP_MS);
  }
}

function extract(text) {
  const out = [];
  for (const line of String(text || "").split(/\n/)) {
    const add = (ioc_type, value) => value && out.push({ ioc_type, value, line: line.trim().slice(0, 200) });
    for (const spec of norm.PLATFORM_ACCOUNTS) {
      const fn = norm.normalizePlatformAccount(spec);
      for (const m of line.match(norm.platformAccountPattern(spec)) || []) add(spec.ioc_type, fn(m));
    }
    for (const m of line.match(new RegExp(norm.LINKEDIN_PATTERN.source, "gi")) || []) add("linkedin_profile", norm.normalizeLinkedin(m));
    for (const m of line.match(norm.WHATSAPP_LINK_PATTERN) || []) add("phone_number", norm.normalizeWhatsappLink(m));
    for (const m of line.match(new RegExp(norm.GITHUB_PATTERN.source, "gi")) || []) add("github_profile", norm.normalizeGithub(m));
    for (const m of line.match(new RegExp(norm.EMAIL_PATTERN.source, "gi")) || []) add("email", norm.normalizeEmail(m));
    // A bare @handle in a Telegram bio is another Telegram account.
    for (const m of line.matchAll(/(^|[\s(:,])@([A-Za-z][A-Za-z0-9_]{3,31})\b/g)) add("telegram_account", `https://t.me/${m[2]}`);
  }
  return out;
}

function rank(args) {
  const all = args.includes("--all");
  const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const have = new Set();
  for (const r of require("../src/_data/iocIndex.js")().records) have.add(String(r.value).toLowerCase());
  const rows = [];
  let gone = 0;
  for (const a of Object.values(data.accounts)) {
    if (!a.exists) { gone++; continue; }
    const seen = new Set();
    for (const v of extract(`${a.title || ""}\n${a.bio || ""}`)) {
      const key = `${v.ioc_type} ${String(v.value).toLowerCase()}`;
      if (seen.has(key) || String(v.value).toLowerCase() === `https://t.me/${a.handle}`.toLowerCase()) continue;
      seen.add(key);
      const known = have.has(String(v.value).toLowerCase());
      if (known && !all) continue;
      rows.push(`${known ? "HAVE" : "NEW "} ${a.handle.padEnd(24)} ${v.ioc_type.padEnd(18)} ${String(v.value).padEnd(44)} ${v.line}`);
    }
  }
  rows.sort();
  console.log(rows.join("\n"));
  console.log(`${rows.length} value(s); ${gone} handle(s) show no account`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "collect") collect(rest).catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "rank") rank(rest);
else {
  console.error("usage: telegram-pivot.js collect [--limit N] [--force] [--extra FILE] | rank [--all]");
  process.exit(2);
}
