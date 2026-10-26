/**
 * html-entities.js — entity decoding for text taken out of HTML and XML
 * ==========================================================================
 * Shared by scripts/scrape-dprk-iocs.js, scripts/discover-sources.js,
 * scripts/ingest-scraped-iocs.js and scripts/lib/feeds.js, so a title or URL
 * is stored as a reader sees it rather than as the markup spelled it. A title
 * stored as `&quot;Million OK!!!!&quot;` is escaped again by the templates and
 * renders with the entity names showing.
 */
"use strict";

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", middot: "·", bull: "•", copy: "©",
};

const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi;

function codePoint(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * One pass over the text: `&amp;quot;` becomes `&quot;`, not `"`. An unknown
 * name or an out-of-range code point is left as written.
 */
function decodeEntities(input) {
  if (input === null || input === undefined) return input;
  return String(input).replace(ENTITY, (match, hex, dec, name) => {
    if (hex) return codePoint(parseInt(hex, 16), match);
    if (dec) return codePoint(Number(dec), match);
    return NAMED_ENTITIES[name.toLowerCase()] ?? match;
  });
}

/**
 * Cloudflare's email protection prints "[email protected]" as the visible
 * text of the link it obfuscates. Once the address is decoded in place the
 * placeholder is left beside it ("name@gmail.com[email protected]"), and
 * where the address could not be decoded the placeholder carries nothing.
 */
const CF_EMAIL_PLACEHOLDER = /\[email(?:\s|&#160;|&nbsp;| )+protected\]/gi;

function stripCfEmailPlaceholder(text) {
  if (typeof text !== "string") return text;
  return text.replace(CF_EMAIL_PLACEHOLDER, "");
}

module.exports = { decodeEntities, stripCfEmailPlaceholder, CF_EMAIL_PLACEHOLDER };
