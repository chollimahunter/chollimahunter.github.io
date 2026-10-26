/**
 * The key two citations share when they point at the same page. A trailing
 * slash, a tracking parameter, a fragment, http against https and a regional
 * Blogger host all name one publication, and keying a registry on the raw URL
 * listed it once per spelling.
 */
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src)$/i;

/**
 * Mirrors and path variants of one article, each as [pattern, replacement] on
 * the host and path. Added only where the same title and date were cited under
 * both spellings.
 */
const ALIASES = [
  [/^d\.hatena\.ne\.jp\/kango\//i, "piyolog.hatenadiary.jp/entry/"],
  [/^(www\.elastic\.co\/)(?:kr\/)?security-labs\/(?:threat-command\/)?/, "$1security-labs/"],
  [/^(chollima-group\.io\/posts\/.+)\.html$/, "$1"],
  [/^(?:blog\.sekoia\.io|(?:www\.)?sekoia\.com\/blog)\//, "sekoia.com/blog/"],
];

function sourceKey(url) {
  const raw = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!/^https?:$/.test(parsed.protocol)) return raw;
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".blogspot.kr")) host = host.replace(/\.blogspot\.kr$/, ".blogspot.com");
  const kept = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name));
  const query = kept.length ? "?" + kept.map(([k, v]) => `${k}=${v}`).join("&") : "";
  const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : "";
  let key = `${host}${parsed.port ? ":" + parsed.port : ""}${pathname}${query}`;
  for (const [pattern, replacement] of ALIASES) key = key.replace(pattern, replacement);
  return key;
}

module.exports = { sourceKey };
