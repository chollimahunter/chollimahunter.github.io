#!/usr/bin/env node
/**
 * guard-servers.js — PreToolUse hook (Bash, PowerShell)
 * ==========================================================================
 * Stops Claude from starting local web servers that outlive the check they
 * were started for. It happened twice in this repository: eight Eleventy dev
 * servers stacked up in one session (21.5 GB, each rebuilding on every file
 * change), and later three `python -m http.server` previews and their shells
 * kept running because they run as python3.12.exe, so stopping "python.exe"
 * stopped nothing.
 *
 *  - python -m http.server, npx http-server and npx serve are refused always.
 *    `npm run preview` (scripts/serve-built.js) serves _site instead and stops
 *    itself after 15 idle minutes.
 *  - eleventy --serve, npm run serve and npm start are refused only while
 *    something already listens on 8080, the dev server's port: reuse it or
 *    stop it first, never start a second one.
 *
 * Reads the hook payload on stdin; prints a deny decision or nothing.
 */
"use strict";
const net = require("net");

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    })
  );
  process.exit(0);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  let raw = "";
  try {
    raw = String((JSON.parse(input).tool_input || {}).command || "");
  } catch {
    process.exit(0);
  }
  // Judge what the shell would run, not text it carries: a commit message,
  // a heredoc or a quoted argument that merely mentions these commands is
  // not starting a server.
  const command = raw
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, "\n")
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, "")
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "''");

  if (/\bpython[0-9.]*(\.exe)?\s+-m\s+http\.server\b|\bnpx\s+(-y\s+)?(http-server|serve)\b/i.test(command)) {
    deny(
      "Throwaway servers are blocked in this repo: they outlive the check (python runs as python3.12.exe, so " +
        "stopping python.exe stops nothing). Use `npm run preview` to serve _site on http://127.0.0.1:8081 (or " +
        "`node scripts/serve-built.js <port>`); it refuses to start twice and stops itself after 15 idle minutes."
    );
  }

  if (/\beleventy\b[^\n]*--serve\b|\bnpm\s+(run\s+serve|start)\b/i.test(command) && (await portInUse(8080))) {
    deny(
      "A server already listens on port 8080. Reuse it, or stop it first with PowerShell: Get-CimInstance " +
        "Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*eleventy*' -and " +
        "$_.CommandLine -like '*--serve*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }. " +
        "For checking a finished build, `npm run preview` stops itself."
    );
  }
  process.exit(0);
});
