#!/usr/bin/env node
/**
 * serve-built.js — a static preview of _site that cannot be left running
 * ==========================================================================
 *   npm run preview            # http://127.0.0.1:8081, after `npm run build`
 *   node scripts/serve-built.js 8082
 *
 * For checking a build in a browser. It exists because throwaway servers kept
 * outliving the check they were started for: `python -m http.server` runs as
 * python3.12.exe here, so stopping "python.exe" stopped nothing, and three
 * servers and their shells were found still running on 29 September 2026,
 * the second time that kind of pile-up happened in this repository.
 *
 * So this server stops itself: after 15 minutes without a request, and after
 * 60 minutes in any case. It also refuses to start when the port is already
 * taken, rather than starting a second server beside the first; it prints
 * what to do instead. Nothing here is needed to stop it by hand, though
 * Ctrl+C still works.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || process.env.PREVIEW_PORT || 8081);
const ROOT = path.join(__dirname, "..", "_site");
const IDLE_MS = Number(process.env.PREVIEW_IDLE_MS) || 15 * 60 * 1000;
const MAX_MS = 60 * 60 * 1000;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".pdf": "application/pdf", ".webmanifest": "application/manifest+json",
};

if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  console.error("No build in _site. Run `npm run build` first.");
  process.exit(1);
}

let idleTimer;
const stop = (why) => {
  console.log(`preview on ${PORT} stopping: ${why}`);
  process.exit(0);
};
const touch = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stop(`${Math.round(IDLE_MS / 60000) || "<1"} minute(s) without a request`), IDLE_MS);
};
setTimeout(() => stop("60-minute limit"), MAX_MS).unref();

const server = http.createServer((req, res) => {
  touch();
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    const notFound = path.join(ROOT, "404.html");
    res.writeHead(404, { "content-type": TYPES[".html"] });
    res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "Not found");
    return;
  }
  // No caching, so a rebuild is what the next load shows.
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use, so no second server was started.\n` +
        `If it is an earlier preview, use it: it serves the current _site and stops on its own.\n` +
        `If it is something else, find it with: Get-NetTCPConnection -LocalPort ${PORT} -State Listen`
    );
    process.exit(2);
  }
  throw e;
});

server.listen(PORT, "127.0.0.1", () => {
  touch();
  console.log(`preview of _site on http://127.0.0.1:${PORT}/ (stops after ${Math.round(IDLE_MS / 60000) || "<1"} idle minute(s), 60 at most)`);
});
