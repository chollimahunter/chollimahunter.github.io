// One-off: pull the persona registry out of the lazarus.group Next.js bundle.
const fs = require("fs");
const vm = require("vm");
const { writeFileAtomic } = require("./lib/write-atomic.js");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "One-off: pull the persona registry out of the lazarus.group Next.js bundle.\n" +
      "usage: node scripts/extract-lazarus-registry.js <chunk.js> <raw.json>"
  );
  process.exit(0);
}

const [, , chunkPath, outPath] = process.argv;
const s = fs.readFileSync(chunkPath, "utf8");

const start = s.indexOf('[{id:"kazune-takeda"');
if (start < 0) throw new Error("persona array not found in chunk");

// Balanced scan that respects string literals, so a bracket inside a value
// never closes the array early.
let depth = 0;
let quote = null;
let end = -1;
for (let i = start; i < s.length; i += 1) {
  const c = s[i];
  if (quote) {
    if (c === "\\") { i += 1; continue; }
    if (c === quote) quote = null;
    continue;
  }
  if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
  if (c === "[" || c === "{") depth += 1;
  else if (c === "]" || c === "}") {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
if (end < 0) throw new Error("unbalanced array literal");

const src = s.slice(start, end);
// Evaluated in an empty context whose only global is Date, so nothing in the
// literal can reach the filesystem, network or process.
const data = vm.runInNewContext("(" + src + ")", { Date }, { timeout: 5000 });

writeFileAtomic(outPath, JSON.stringify(data, null, 1));
console.log("literal length:", src.length);
console.log("personas:", data.length);
console.log("keys seen across all:", [...new Set(data.flatMap((p) => Object.keys(p)))].join(", "));
