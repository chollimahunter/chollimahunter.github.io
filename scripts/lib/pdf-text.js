/**
 * pdf-text.js — text extraction from a PDF, with no dependencies
 * ==========================================================================
 * The most authoritative sources on DPRK IT-worker activity are PDFs: UN and
 * multilateral sanctions reports, government advisories, vendor white papers.
 * They are also the ones whose annexes actually list addresses and aliases.
 * `scripts/scrape-dprk-iocs.js` accepted HTML and plain text only, so every
 * one of them was rejected at the content-type gate.
 *
 * WHY THIS IS HAND-ROLLED
 * -----------------------
 * The repository has no runtime dependencies, and `.github/workflows/
 * scrape-dprk-iocs.yml` runs `node scripts/…` directly with no install step —
 * adding a PDF library would mean adding a lockfile and an `npm ci` to CI for
 * one code path. Everything needed here is in Node's standard library: a PDF
 * is a container of objects, its streams are raw DEFLATE, and `zlib` inflates
 * them. The same reasoning produced scripts/lib/keccak256.js.
 *
 * WHAT IT DOES AND DOES NOT DO
 * ----------------------------
 * It returns the text of the page content streams, in page order, with the
 * per-font `/ToUnicode` map applied so that subset-embedded fonts come out as
 * readable characters rather than glyph indices. That is what an extractor
 * needs: a flat run of prose and table cells.
 *
 * It does NOT reconstruct layout. Column order, table cell boundaries and
 * running heads are lost, and a value split across a line break is split here
 * too. That matters less than it sounds for this use: the indicator regexes
 * match within a line, and the surrounding-text window is used as a quote a
 * reviewer reads, not as a claim about the document's structure.
 *
 * A PDF whose text is only in scanned images yields nothing. There is no OCR
 * here and should not be: a value nobody can check against extractable text is
 * not something this site publishes.
 */

const zlib = require("zlib");

/** A PDF is parsed as latin1 so one byte is one character and offsets are byte offsets. */
const BINARY = "latin1";

/** A single stream's inflated output is capped here — a hostile or malformed
 * stream can claim to deflate a few kilobytes into gigabytes, and Node's own
 * zlib bindings enforce this bound for us by throwing a RangeError once the
 * output would exceed it. */
const MAX_STREAM_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The ceiling on total inflated bytes for one document, across every stream
 * it holds — see the `budget` threaded through pdfToText below. */
const MAX_TOTAL_INFLATED_BYTES = 256 * 1024 * 1024;

/**
 * Inflate a stream, tolerating the two framings PDFs use interchangeably.
 * Producers disagree about whether `/FlateDecode` carries a zlib header, and a
 * truncated stream is common enough in real files that a partial inflate is
 * worth more than an exception.
 *
 * `budget` tracks bytes inflated across the whole document (see pdfToText),
 * so one PDF cannot be made to decompress an unbounded amount of data by
 * spreading it across many separately-capped streams. Once it is spent, this
 * refuses to even attempt the stream — treated the same as an unreadable one.
 */
function inflate(bytes, budget) {
  if (budget && budget.remaining <= 0) return null;
  const options = { maxOutputLength: MAX_STREAM_OUTPUT_BYTES };
  const attempts = [
    () => zlib.inflateSync(bytes, options),
    () => zlib.inflateRawSync(bytes, options),
    () => zlib.inflateSync(bytes, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(bytes, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out && out.length) {
        if (budget) budget.remaining -= out.length;
        return out;
      }
    } catch {
      // Either framing failed, or maxOutputLength was exceeded (a RangeError):
      // both are treated the same way an existing inflate failure is — try the
      // next framing, or give up on this stream.
    }
  }
  return null;
}

/**
 * Every `N G obj … endobj` in the file, keyed by object number.
 *
 * This reads the objects directly rather than following the cross-reference
 * table. A linearized or incrementally-updated PDF has several xref sections
 * and object streams pointing at each other; scanning finds every object in
 * one pass regardless, and a later definition of the same number overwrites an
 * earlier one, which is what an incremental update means anyway.
 */
function parseObjects(raw) {
  const objects = new Map();
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;

  while ((match = pattern.exec(raw)) !== null) {
    const number = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const end = raw.indexOf("endobj", bodyStart);
    if (end === -1) continue;

    const body = raw.slice(bodyStart, end);
    const streamAt = body.indexOf("stream");
    let dict = body;
    let stream = null;

    if (streamAt !== -1) {
      dict = body.slice(0, streamAt);
      // The stream data begins after the EOL that must follow the keyword.
      let from = streamAt + "stream".length;
      if (body[from] === "\r") from += 1;
      if (body[from] === "\n") from += 1;
      const streamEnd = body.lastIndexOf("endstream");
      if (streamEnd > from) stream = body.slice(from, streamEnd);
    }

    objects.set(number, { dict, stream });
    // Skip past this object so a nested "N 0 obj" inside stream data — which
    // happens in object streams — is not read as a top-level object.
    pattern.lastIndex = end;
  }

  return objects;
}

/** `12 0 R` → 12, for a named key in a dictionary fragment. */
function refFor(dict, key) {
  const match = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`));
  return match ? Number(match[1]) : null;
}

/** The decoded bytes of an object's stream, or null if it is not inflatable. */
function streamBytes(object, budget) {
  if (!object || object.stream === null) return null;
  const bytes = Buffer.from(object.stream, BINARY);
  if (!/\/Filter\b/.test(object.dict)) return bytes;
  if (!/FlateDecode/.test(object.dict)) return null;
  return inflate(bytes, budget);
}

/**
 * Split a dictionary fragment into its top-level `/Key value` pairs.
 *
 * Written by hand rather than with a regex because the values nest: a font
 * resource dictionary is `/Font << /F1 5 0 R /F2 9 0 R >>` inside a `/Resources
 * << … >>`, and a regex that stops at the first `>>` closes the wrong one.
 */
function dictBody(text, key) {
  const at = text.indexOf(`/${key}`);
  if (at === -1) return null;
  const open = text.indexOf("<<", at);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < text.length - 1; i += 1) {
    if (text[i] === "<" && text[i + 1] === "<") {
      depth += 1;
      i += 1;
    } else if (text[i] === ">" && text[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return text.slice(open + 2, i - 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ToUnicode CMaps
// ---------------------------------------------------------------------------

/** `<0041>` → 0x41. Codes are written as hex strings of one or more bytes. */
function hexValue(token) {
  return parseInt(token.replace(/[<>]/g, ""), 16);
}

/** `<00410042>` → "AB". A destination may map one code to several characters. */
function hexString(token) {
  const hex = token.replace(/[<>\s]/g, "");
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(code)) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * The `/ToUnicode` CMap of one font, as a code → string map.
 *
 * This is the piece that makes a modern PDF readable at all. A report typeset
 * in InDesign or Word embeds subset fonts whose byte codes are glyph indices
 * with no relation to ASCII, so extracting the raw string operands yields
 * mojibake. The CMap is the document's own statement of what each code means.
 */
function parseToUnicode(bytes) {
  const text = bytes.toString(BINARY);
  const map = new Map();

  const charSection = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = charSection.exec(text)) !== null) {
    const pairs = block[1].match(/<[0-9a-fA-F]+>/g) || [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      map.set(hexValue(pairs[i]), hexString(pairs[i + 1]));
    }
  }

  const rangeSection = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeSection.exec(text)) !== null) {
    // Two forms: `<lo> <hi> <dst>` walks the destination up with the code, and
    // `<lo> <hi> [<a> <b> …]` names each destination individually.
    const entries = block[1].match(/<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*(?:\[[\s\S]*?\]|<[0-9a-fA-F]+>)/g) || [];
    for (const entry of entries) {
      const bounds = entry.match(/<[0-9a-fA-F]+>/g) || [];
      const lo = hexValue(bounds[0]);
      const hi = hexValue(bounds[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 0xffff) continue;

      if (entry.includes("[")) {
        const list = (entry.slice(entry.indexOf("[")).match(/<[0-9a-fA-F]+>/g) || []);
        for (let i = 0; i <= hi - lo && i < list.length; i += 1) {
          map.set(lo + i, hexString(list[i]));
        }
      } else {
        const base = hexString(bounds[2]);
        const head = base.slice(0, -1);
        const tail = base.charCodeAt(base.length - 1);
        for (let i = 0; i <= hi - lo; i += 1) {
          map.set(lo + i, head + String.fromCharCode(tail + i));
        }
      }
    }
  }

  return map;
}

/**
 * The fonts a page's resources name, as `{ [resourceName]: { cmap, twoByte } }`.
 *
 * `twoByte` follows the font's own subtype rather than being guessed from the
 * data: a Type0 font is addressed with two-byte codes, a simple font with one,
 * and reading a Type0 string a byte at a time produces convincing nonsense
 * rather than an obvious failure.
 */
function fontsFor(pageDict, objects, budget) {
  const fonts = new Map();
  let resources = dictBody(pageDict, "Resources");
  if (!resources) {
    const ref = refFor(pageDict, "Resources");
    const object = ref !== null ? objects.get(ref) : null;
    resources = object ? object.dict : null;
  }
  if (!resources) return fonts;

  const fontDict = dictBody(resources, "Font");
  if (!fontDict) return fonts;

  const entries = fontDict.match(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g) || [];
  for (const entry of entries) {
    const parsed = entry.match(/\/([^\s/<>[\]]+)\s+(\d+)/);
    if (!parsed) continue;
    const font = objects.get(Number(parsed[2]));
    if (!font) continue;

    const toUnicodeRef = refFor(font.dict, "ToUnicode");
    const toUnicode = toUnicodeRef !== null ? streamBytes(objects.get(toUnicodeRef), budget) : null;
    fonts.set(parsed[1], {
      cmap: toUnicode ? parseToUnicode(toUnicode) : null,
      twoByte: /\/Subtype\s*\/Type0\b/.test(font.dict),
    });
  }

  return fonts;
}

// ---------------------------------------------------------------------------
// Content streams
// ---------------------------------------------------------------------------

/** PDF string escapes, as written inside `( … )`. */
const ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/**
 * Read a literal string operand starting at an opening parenthesis.
 * Returns the raw bytes and where the string ended; decoding to characters is
 * the caller's job, because it depends on which font is active.
 */
function readLiteral(text, start) {
  let out = "";
  let depth = 1;
  let i = start + 1;

  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      if (next in ESCAPES) {
        out += ESCAPES[next];
        i += 2;
      } else if (next >= "0" && next <= "7") {
        const octal = text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        out += String.fromCharCode(parseInt(octal, 8));
        i += 1 + octal.length;
      } else if (next === "\n") {
        i += 2; // A backslash before a newline is a line continuation.
      } else {
        out += next;
        i += 2;
      }
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { value: out, end: i + 1 };
    }
    out += char;
    i += 1;
  }

  return { value: out, end: text.length };
}

/** Bytes of a string operand → characters, through the active font's CMap. */
function decodeString(bytes, font) {
  if (!font || !font.cmap) {
    // No CMap: the codes are the font's built-in encoding, which for the
    // simple fonts that lack a CMap is Latin-1 compatible in its printable
    // range — exactly the range an email address or a handle lives in.
    return bytes;
  }

  const step = font.twoByte ? 2 : 1;
  let out = "";
  for (let i = 0; i < bytes.length; i += step) {
    const code =
      step === 2 ? (bytes.charCodeAt(i) << 8) | (bytes.charCodeAt(i + 1) || 0) : bytes.charCodeAt(i);
    const mapped = font.cmap.get(code);
    out += mapped !== undefined ? mapped : String.fromCharCode(code);
  }
  return out;
}

/**
 * The text of one content stream.
 *
 * A content stream is postfix: operands are pushed, then an operator consumes
 * them. This reads it that way rather than pattern-matching operators in place,
 * because the difference between an operand and a drawing instruction decides
 * where the line breaks go — and a line break in the wrong place is not a
 * cosmetic problem here. An address broken across two lines matches no regex
 * and is silently lost, which is worse than not reading the document at all.
 *
 * Only the text operators are interpreted. Positioning is read for exactly one
 * purpose: telling a genuine new line from a horizontal reposition. A PDF sets
 * type in short runs, several per visual line, so treating every `Td` as a line
 * ending chops words in half; only a move with a vertical component is a line.
 */
function textFromContent(content, fonts) {
  let out = "";
  let font = null;
  let stack = [];
  let lastY = null;
  let i = 0;

  const emit = (text) => {
    out += text;
  };
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const space = () => {
    if (out && !/[\s]$/.test(out)) out += " ";
  };

  /** The numeric operand `back` positions from the top of the stack. */
  const numberAt = (back) => {
    const token = stack[stack.length - back];
    return token && token.type === "num" ? token.value : null;
  };

  const showArray = (items) => {
    for (const item of items) {
      if (item.type === "str") emit(decodeString(item.bytes, font));
      // A wide negative kern is how a PDF draws a gap it never writes a space
      // character for — between table cells, and between words in justified
      // text. Below this threshold the gap is letter-spacing, not a space.
      else if (item.type === "num" && item.value <= -120) space();
    }
  };

  while (i < content.length) {
    const char = content[i];

    if (char === "%") {
      const eol = content.indexOf("\n", i);
      i = eol === -1 ? content.length : eol + 1;
      continue;
    }

    if (char === "(") {
      const { value, end } = readLiteral(content, i);
      stack.push({ type: "str", bytes: value });
      i = end;
      continue;
    }

    if (char === "<" && content[i + 1] !== "<") {
      const close = content.indexOf(">", i);
      if (close === -1) break;
      const hex = content.slice(i + 1, close).replace(/\s+/g, "");
      let bytes = "";
      for (let h = 0; h + 1 < hex.length; h += 2) {
        bytes += String.fromCharCode(parseInt(hex.slice(h, h + 2), 16));
      }
      stack.push({ type: "str", bytes });
      i = close + 1;
      continue;
    }

    // A dictionary operand: skipped whole, so its contents are never mistaken
    // for operators. Inline images (BI … ID … EI) are the other binary run and
    // are handled at the EI operator below.
    if (char === "<" && content[i + 1] === "<") {
      let depth = 0;
      let j = i;
      while (j < content.length - 1) {
        if (content[j] === "<" && content[j + 1] === "<") { depth += 1; j += 2; continue; }
        if (content[j] === ">" && content[j + 1] === ">") { depth -= 1; j += 2; if (!depth) break; continue; }
        j += 1;
      }
      i = j;
      continue;
    }

    if (char === "[") {
      const items = [];
      let j = i + 1;
      while (j < content.length && content[j] !== "]") {
        if (content[j] === "(") {
          const { value, end } = readLiteral(content, j);
          items.push({ type: "str", bytes: value });
          j = end;
          continue;
        }
        if (content[j] === "<") {
          const close = content.indexOf(">", j);
          if (close === -1) break;
          const hex = content.slice(j + 1, close).replace(/\s+/g, "");
          let bytes = "";
          for (let h = 0; h + 1 < hex.length; h += 2) {
            bytes += String.fromCharCode(parseInt(hex.slice(h, h + 2), 16));
          }
          items.push({ type: "str", bytes });
          j = close + 1;
          continue;
        }
        const number = content.slice(j).match(/^-?\d+(?:\.\d+)?/);
        if (number) {
          items.push({ type: "num", value: Number(number[0]) });
          j += number[0].length;
          continue;
        }
        j += 1;
      }
      stack.push({ type: "arr", items });
      i = j + 1;
      continue;
    }

    if (char === "/") {
      const name = content.slice(i + 1).match(/^[^\s/<>[\](){}%]*/)[0];
      stack.push({ type: "name", value: name });
      i += 1 + name.length;
      continue;
    }

    const number = content.slice(i).match(/^[-+]?(?:\d+\.?\d*|\.\d+)/);
    if (number) {
      stack.push({ type: "num", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }

    const operator = content.slice(i).match(/^[A-Za-z'"*][A-Za-z0-9*'"]*/);
    if (!operator) {
      i += 1;
      continue;
    }
    const op = operator[0];
    i += op.length;

    switch (op) {
      case "Tf": {
        const name = stack[stack.length - 2];
        if (name && name.type === "name") font = fonts.get(name.value) || null;
        break;
      }
      case "Tj": {
        const top = stack[stack.length - 1];
        if (top && top.type === "str") emit(decodeString(top.bytes, font));
        break;
      }
      case "'":
      case '"': {
        newline();
        const top = stack[stack.length - 1];
        if (top && top.type === "str") emit(decodeString(top.bytes, font));
        break;
      }
      case "TJ": {
        const top = stack[stack.length - 1];
        if (top && top.type === "arr") showArray(top.items);
        break;
      }
      case "Td":
      case "TD": {
        // `tx ty Td`. A pure horizontal move continues the same visual line —
        // it is how a run of bold text or a table cell is positioned.
        const ty = numberAt(1);
        if (ty !== null && ty !== 0) newline();
        else space();
        break;
      }
      case "Tm": {
        // `a b c d e f Tm` sets the text matrix outright; f is the baseline.
        // Generators that position every line this way never emit Td at all.
        const y = numberAt(1);
        if (y !== null && lastY !== null && Math.abs(y - lastY) > 0.5) newline();
        lastY = y;
        break;
      }
      case "T*":
      case "ET":
        newline();
        if (op === "ET") lastY = null;
        break;
      case "BI": {
        // An inline image's binary data would tokenize as garbage operators.
        const end = content.indexOf("EI", i);
        i = end === -1 ? content.length : end + 2;
        break;
      }
      default:
        break;
    }

    stack = [];
  }

  return out;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Put hyphenated words and URLs back together.
 *
 * A typesetter draws a hyphen as its own positioned run, so it lands on a line
 * of its own and the text comes out as "Know\n-\nYour\n-\nCustomer". In prose
 * that is merely ugly. In an indicator annex it is destructive: this document
 * writes a LinkedIn profile as `linkedin.com/in/lai-we-wang-ba355a1a2`, and
 * split at every hyphen the extractor matched `/in/lai` and threw the rest
 * away — a wrong indicator rather than a missing one.
 *
 * Only a hyphen with word characters on both sides is rejoined, so a dash used
 * as punctuation between clauses stays a break.
 */
function rejoinHyphens(text) {
  return text
    .replace(/(\w)[ \t]*\n[ \t]*-[ \t]*\n[ \t]*(\w)/g, "$1-$2")
    .replace(/(\w)-[ \t]*\n[ \t]*(\w)/g, "$1-$2")
    .replace(/(\w)[ \t]*\n[ \t]*-(\w)/g, "$1-$2");
}

/** `/Contents 4 0 R` or `/Contents [4 0 R 5 0 R]` → the object numbers. */
function contentRefs(pageDict) {
  const single = pageDict.match(/\/Contents\s+(\d+)\s+\d+\s+R\b/);
  if (single) return [Number(single[1])];
  const array = pageDict.match(/\/Contents\s*\[([\s\S]*?)\]/);
  if (!array) return [];
  return (array[1].match(/(\d+)\s+\d+\s+R/g) || []).map((ref) => Number(ref.match(/\d+/)[0]));
}

/** The document title from its `/Info` dictionary, where it has a usable one. */
function titleFrom(objects) {
  for (const object of objects.values()) {
    const match = object.dict.match(/\/Title\s*\(([^)]*)\)/);
    if (match && match[1].trim()) return match[1].replace(/\\(.)/g, "$1").trim();
    const hex = object.dict.match(/\/Title\s*<([0-9a-fA-F\s]+)>/);
    if (hex) {
      const text = hexString(`<${hex[1]}>`).replace(/^﻿/, "").trim();
      if (text) return text;
    }
  }
  return null;
}

/** `D:20251022143000Z` → `2025-10-22`. */
function creationDateFrom(objects) {
  for (const object of objects.values()) {
    const match = object.dict.match(/\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return null;
}

/**
 * Extract the readable text of a PDF.
 *
 * @param {Buffer} buffer - the whole file.
 * @returns {{ text: string, title: string|null, published: string|null, pages: number }}
 */
function pdfToText(buffer) {
  const raw = buffer.toString(BINARY);
  const objects = parseObjects(raw);

  // Total bytes inflated across this whole document. Shared across every
  // streamBytes() call below so a PDF built of many separately-small streams
  // cannot add up to an unbounded amount of decompressed data; see inflate()
  // in this file.
  const budget = { remaining: MAX_TOTAL_INFLATED_BYTES };

  // Object streams hold compressed objects in bulk in a modern PDF, including
  // most page and font dictionaries. Their contents are parsed as ordinary
  // objects and folded in, without overwriting a definition already found in
  // the file body — an incremental update lives there and is newer.
  for (const object of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(object.dict)) continue;
    const bytes = streamBytes(object, budget);
    if (!bytes) continue;
    for (const [number, nested] of parseObjects(bytes.toString(BINARY))) {
      if (!objects.has(number)) objects.set(number, nested);
    }
  }

  const pages = [];
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(object.dict)) continue;
    pages.push(object);
  }

  let text = "";
  for (const page of pages) {
    const fonts = fontsFor(page.dict, objects, budget);
    for (const ref of contentRefs(page.dict)) {
      const bytes = streamBytes(objects.get(ref), budget);
      if (!bytes) continue;
      text += textFromContent(bytes.toString(BINARY), fonts) + "\n";
    }
  }

  // An object-stream PDF may define pages without a body-level /Type /Page, and
  // a linearized one may hide content behind a cross-reference stream. Falling
  // back to every inflatable stream that looks like page content recovers those
  // rather than returning an empty document.
  if (text.replace(/\s/g, "").length < 200) {
    for (const object of objects.values()) {
      const bytes = streamBytes(object, budget);
      if (!bytes) continue;
      const content = bytes.toString(BINARY);
      if (!/\bBT\b[\s\S]*?\bET\b/.test(content)) continue;
      text += textFromContent(content, new Map()) + "\n";
    }
  }

  return {
    text: rejoinHyphens(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    title: titleFrom(objects),
    published: creationDateFrom(objects),
    pages: pages.length,
  };
}

module.exports = { pdfToText };
