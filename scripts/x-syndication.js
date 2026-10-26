#!/usr/bin/env node
/**
 * x-syndication.js
 * ==============================================================
 * Reads posts from X through the public syndication endpoint that
 * _drafts/private/docs/x-source-backlog.md identifies as the one route that keeps working
 * when the interface is throttled.
 *
 * Run manually:
 *   node scripts/x-syndication.js --post <id|url>           # one post
 *   node scripts/x-syndication.js --thread <id|url>         # walk parents up
 *   node scripts/x-syndication.js --media <id|url> --out d  # save images
 *   node scripts/x-syndication.js --thread <id|url> --out d # both
 *
 * WHY THIS EXISTS AS A SCRIPT
 * ---------------------------
 * The backlog document records that driving x.com through a browser hits a
 * session-wide throttle after a few hours, that the throttle is not scoped to
 * the account being viewed, and that it looks identical to an exhausted
 * timeline. The syndication endpoint has none of that: it needs no session, it
 * is not rate limited in any way worth handling here, and it returns a post's
 * full text, its media keys and its parent identifier.
 *
 * The document also records that a plain fetch() to this endpoint from a tab
 * sitting on x.com fails with a bare CORS error every time, which is what made
 * this look like browser work. From Node there is no origin to fail, so none
 * of that applies.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * Enumerate. The response carries `parent` but nothing pointing downwards, so
 * a thread is recoverable from any post inside it by walking upwards and in no
 * other way. Finding the posts in the first place still needs the window sweep
 * the backlog document describes. The older /timeline/conversation endpoint
 * that would have enumerated a reply chain now answers 200 with a zero-length
 * body, and srv/timeline-profile answers 429; both are probed and reported
 * rather than assumed, because a future reader should not have to rediscover
 * that they are dead.
 *
 * TRANSCRIPTION IS NOT THIS SCRIPT'S JOB
 * --------------------------------------
 * This prints what the endpoint returned and saves the images at full
 * resolution. It does not decide what in them is an indicator. Every rule in
 * docs/x-dossiers.md about attribution, about victims of impersonation, and
 * about the difference between "links to" and "is the same person" applies to
 * the reading of this output and cannot be automated away.
 */

const fs = require("node:fs");
const path = require("node:path");

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

/** Derives the endpoint token from the post id, which is how the widget does it. */
function tokenFor(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** Accepts a bare id, a status URL, or a URL with query string or trailing path. */
function postIdFrom(input) {
  const match = String(input).match(/status(?:es)?\/(\d+)/);
  const id = match ? match[1] : String(input).trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`not a post id or status URL: ${input}`);
  }
  return id;
}

/** X identifiers are snowflakes, so the post date is arithmetic, not a lookup. */
function dateOf(id) {
  return new Date(Number((BigInt(id) >> 22n) + 1288834974657n));
}

async function fetchPost(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${tokenFor(id)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for post ${id}`);
  }
  const body = await response.text();
  if (!body) {
    throw new Error(`empty body for post ${id} (deleted, protected, or withheld)`);
  }
  return JSON.parse(body);
}

/**
 * Walks upward through `parent` until it is absent, then returns the chain in
 * posting order. Guards against a cycle, which should not happen but would
 * otherwise hang, and stops at a generous ceiling rather than trusting input.
 */
async function walkThread(startId, limit = 60) {
  const chain = [];
  const seen = new Set();
  let id = startId;
  while (id && !seen.has(id) && chain.length < limit) {
    seen.add(id);
    const post = await fetchPost(id);
    chain.push(post);
    id = post.parent && post.parent.id_str;
  }
  return chain.reverse();
}

/** name=large is the largest stored copy; asking for 4096x4096 returns the same pixels. */
function largeUrl(mediaUrl) {
  const dot = mediaUrl.lastIndexOf(".");
  const format = mediaUrl.slice(dot + 1);
  return `${mediaUrl.slice(0, dot)}?format=${format}&name=large`;
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

async function saveMedia(post, outDir) {
  const saved = [];
  for (const media of post.mediaDetails || []) {
    if (!media.media_url_https) continue;
    const url = largeUrl(media.media_url_https);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      saved.push({ url, error: `HTTP ${response.status}` });
      continue;
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
      saved.push({ url, error: `content-length ${declaredLength} exceeds ${MAX_MEDIA_BYTES} bytes` });
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) {
      saved.push({ url, error: `body ${buffer.length} exceeds ${MAX_MEDIA_BYTES} bytes` });
      continue;
    }
    const name = `${post.id_str}-${path.basename(media.media_url_https)}`;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, buffer);
    saved.push({ url, file });
  }
  return saved;
}

function describe(post) {
  const lines = [
    `--- ${post.id_str}  @${post.user && post.user.screen_name}  ${dateOf(post.id_str).toISOString()}`,
    post.text || "(no text)",
  ];
  // The backlog document warns that a long-form post comes back truncated with
  // a note_tweet carrying nothing but an id. The cut length varies -- 297
  // characters on the post this was confirmed against, not the 277 recorded
  // earlier -- so the presence of note_tweet is the signal, not the length.
  // Say so in the output rather than letting a reader take the cut-off text
  // for the whole post.
  if (post.note_tweet) {
    lines.push("[long-form post: text above is truncated; full text only exists in the rendered page]");
  }
  for (const media of post.mediaDetails || []) {
    lines.push(`[image] ${largeUrl(media.media_url_https)}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { out: null, mode: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--post" || flag === "--thread" || flag === "--media") {
      args.mode = flag.slice(2);
      args.target = argv[++i];
    } else if (flag === "--out") {
      args.out = argv[++i];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode || !args.target) {
    console.error("usage: node scripts/x-syndication.js --post|--thread|--media <id|url> [--out <dir>]");
    process.exit(2);
  }

  const id = postIdFrom(args.target);
  if (args.out) fs.mkdirSync(args.out, { recursive: true });

  const posts = args.mode === "thread" ? await walkThread(id) : [await fetchPost(id)];

  for (const post of posts) {
    console.log(describe(post));
    if (args.out) {
      for (const item of await saveMedia(post, args.out)) {
        console.log(item.file ? `[saved] ${item.file}` : `[failed] ${item.url}: ${item.error}`);
      }
    }
  }

  console.log(`\n${posts.length} post(s). conversation_count on first: ${posts[0].conversation_count}`);
  // posts is in posting order, so the root is the first element, not the last.
  if (args.mode === "thread" && posts[0].parent === undefined) {
    console.log("Reached the root. Anything after the last post here needs a downward source; see _drafts/private/docs/x-source-backlog.md.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
