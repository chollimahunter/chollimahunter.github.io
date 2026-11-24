"use strict";

/**
 * Puts a React-streamed page back in document order.
 *
 * A page rendered with React's streaming server renderer (Next.js and the
 * like) sends the parts that were not ready as hidden chunks at the end of the
 * body, each followed by a script that moves it into a placeholder:
 *
 *   <template id="P:1f"></template>                 where it belongs
 *   <table hidden><tr id="S:1f"><td>1.0.1</td></tr></table>
 *   <script>$RS("S:1f","P:1f")</script>             moves S:1f's children there
 *
 * Read without running the script, a table breaks off after its first rows
 * and the rest of its cells land, out of order, at the end of the page.
 * ReversingLabs' blog is built this way. This does what $RS does: each
 * chunk's children replace its placeholder, then the chunk is dropped. A
 * page with no such chunks is returned unchanged.
 */

const CHUNK =
  /(?:<table hidden>)?<(div|tr|tbody)\b[^>]*\bid="S:([0-9a-z]+)"[^>]*>([\s\S]*?)<\/\1>(?:<\/table>)?<script>\$RS\("S:\2","P:([0-9a-z]+)"\)<\/script>/gi;

function resolveStreamedHtml(html) {
  if (!html.includes("$RS(")) return html;
  const fill = new Map();
  const rest = html.replace(CHUNK, (_, tag, s, inner, p) => {
    fill.set(p, inner);
    return "";
  });
  if (!fill.size) return html;
  let out = rest;
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    out = out.replace(/<template id="P:([0-9a-z]+)"><\/template>/gi, (match, p) => {
      if (!fill.has(p)) return match;
      changed = true;
      return fill.get(p);
    });
    if (!changed) break;
  }
  return out;
}

module.exports = { resolveStreamedHtml };
