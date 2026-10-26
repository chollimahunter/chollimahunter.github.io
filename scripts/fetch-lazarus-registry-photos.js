#!/usr/bin/env node
/**
 * fetch-lazarus-registry-photos.js
 * ==========================================================================
 * Downloads every image the lazarus.group registry publishes that has no
 * decision yet in scripts/data/lazarus-registry-images.json, for an eye check
 * before anything is mirrored into src/assets/img/personas/, because this repo never hotlinks an image it
 * displays — the same rule scripts/enrich-linkedin-accounts.js follows for
 * profile avatars.
 *
 * Images tagged `document` (KYC captures, passports, identity cards) are
 * downloaded too: on 28 September 2026 the maintainer decided to carry them.
 * They are captioned as documents whose name, number and photograph may
 * belong to a real person whose identity was stolen, and kept out of the face
 * grid (kind "document", face false in the data file).
 *
 * Run after scripts/extract-lazarus-registry.js has produced the persona JSON:
 *
 *   node scripts/fetch-lazarus-registry-photos.js <personas.json> [outDir]
 *
 * Images land at their original size and format, named
 * lazarus-group-<id>--<registry file name>. Look at every one, record the
 * decision in the data file, and convert the ones used before committing --
 * see docs/third-party-registries.md. The `face` tag is not a decision: the
 * registry puts it on crowds, identity cards and cartoons.
 */

const fs = require("fs");
const path = require("path");

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

const ORIGIN = "https://lazarus.group";
const USER_AGENT =
  "ChollimaHunterScraper/1.0 (+https://chollimahunter.github.io/; public DPRK threat-intel index)";
const DELAY_MS = 400;
const FETCH_TIMEOUT_MS = 30000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * persona.id becomes a filename below, and it comes out of extract-lazarus-
 * registry.js's VM evaluation of a third party's own JS bundle — not
 * something this script should trust to be a plain slug. Anything that isn't
 * one is skipped rather than sanitized, because a sanitized-but-wrong id would
 * silently write under the wrong name instead of failing loudly.
 */
function safeId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(id) ? id : null;
}

async function main() {
  const [, , personasPath, outDirArg] = process.argv;
  if (!personasPath) throw new Error("usage: fetch-lazarus-registry-photos.js <personas.json> [outDir]");
  const outDir = outDirArg || path.join(__dirname, "..", "_drafts", "registry-photos");
  fs.mkdirSync(outDir, { recursive: true });

  const personas = JSON.parse(fs.readFileSync(personasPath, "utf8"));
  let saved = 0;
  let skipped = 0;
  const failures = [];
  const decided = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "lazarus-registry-images.json"), "utf8")
  ).images;

  for (const persona of personas) {
    const id = safeId(persona.id);
    if (!id) {
      console.warn(`  skipping persona with unsafe id: ${JSON.stringify(persona.id)}`);
      skipped += 1;
      continue;
    }

    const pending = (persona.images || []).filter(
      (image) => image.path && !decided[image.path]
    );
    if (!pending.length) {
      skipped += 1;
      continue;
    }
    for (const face of pending) {

    let url;
    try {
      url = new URL(face.path, ORIGIN);
    } catch {
      failures.push(`${id}: unparseable image path ${JSON.stringify(face.path)}`);
      continue;
    }
    if (url.origin !== ORIGIN) {
      failures.push(`${id}: image path resolved off-origin (${url.origin})`);
      continue;
    }
    const ext = path.extname(url.pathname).toLowerCase() || ".jpg";
    const base = path.basename(url.pathname, path.extname(url.pathname)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const target = path.join(outDir, `lazarus-group-${id}--${base}${ext}`);

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = (response.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("image/")) throw new Error(`content-type ${type || "unknown"}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        throw new Error(`content-length ${declaredLength} exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`body ${arrayBuffer.byteLength} exceeds ${MAX_IMAGE_BYTES} bytes`);
      }
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(target, buffer);
      saved += 1;
      console.log(`  ${id} -> ${path.basename(target)} (${buffer.length} bytes)`);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
    }
    await sleep(DELAY_MS);
    }
  }

  console.log(`\nsaved ${saved}, nothing new to review ${skipped}, failed ${failures.length}`);
  failures.forEach((failure) => console.log("  FAILED " + failure));
  console.log(`Output: ${outDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
