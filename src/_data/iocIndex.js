/**
 * iocIndex.js — the unified indicator index
 * ==========================================================================
 * Merges every indicator the site holds into one flat list: the bulk
 * identifier datasets in iocs/itworker-datasets.json (DTEX's email
 * addresses), iocs/polinrider-affected-repos.json (OpenSourceMalware's
 * PolinRider-compromised repo list) and
 * iocs/osm-malicious-package-versions.json (version-pinned malicious npm
 * releases from OpenSourceMalware's reporting), and the per-indicator records in
 * iocs/scraped-iocs.json produced by scripts/ingest-scraped-iocs.js.
 *
 * This is a JavaScript data file rather than an 11ty collection on purpose.
 * The collection names in .eleventy.js are a reserved registry owned by
 * specific parts of the site, and the merge itself is more logic than a
 * Nunjucks template should carry.
 *
 * Consumed by:
 *   src/remote-workers/index.njk    — the search page and its no-JS fallback
 *   src/sources/index.njk           — the site-wide source list
 *   src/ioc-index.njk               — the compact JSON index the browser fetches
 */

const path = require("path");

const { recordId } = require("../../scripts/lib/ioc-normalize.js");
const { platformAccountStatus } = require("../../scripts/lib/platform-status.js");
const { malwareStatus } = require("../../scripts/lib/malware-status.js");
const { osvAdvisories } = require("../../scripts/lib/osv-malicious.js");
const { buildPersonas, personaByValue, personasByValue } = require("../../scripts/lib/personas.js");
const { recordsFromDossiers } = require("../../scripts/lib/dossiers.js");
const { recordsFromCandidates } = require("../../scripts/lib/candidates.js");
const { memoByDir } = require("../../scripts/lib/memo.js");
const { sourceKey: pageKey } = require("../../scripts/lib/source-url.js");
const { readJsonIfPresent } = require("../../scripts/lib/read-json.js");
const { compareText } = require("../../scripts/lib/compare.js");
const { canonicalPublisher } = require("../../scripts/lib/publishers.js");
const { operatorHosts } = require("../../scripts/lib/operator-hosts.js");

const IOCS_DIR = path.join(__dirname, "iocs");

/**
 * What kind of network each IP address sits on, from scripts/enrich-ips.js.
 * Read once per build; an address with no entry gets no network block, since
 * "not looked up" and "unknown" are different claims. See docs/ip-network-types.md.
 */
const IP_LOOKUP_PATH = path.join(__dirname, "..", "..", "scripts", "data", "ip-lookups.json");
const ipLookups = readJsonIfPresent(IP_LOOKUP_PATH, { addresses: {} });

/**
 * When each registrable domain was registered, from scripts/enrich-domains.js.
 * Keyed by domain; a subdomain is never looked up and gets no block.
 */
const DOMAIN_LOOKUP_PATH = path.join(__dirname, "..", "..", "scripts", "data", "domain-registration.json");
const domainLookups = readJsonIfPresent(DOMAIN_LOOKUP_PATH, { domains: {} });

function registrationFor(value) {
  const text = String(value || "").trim();
  let host = null;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const entry = domainLookups.domains[host];
  return entry ? { domain: host, ...entry } : null;
}

/** The words a network kind is shown as. */
const NETWORK_KIND_LABELS = {
  vpn: "VPN",
  proxy: "proxy or VPN",
  datacenter: "data centre",
  mobile: "mobile carrier",
  "fixed-line": "fixed line",
  unresolved: "unresolved",
};

function networkStatus(value, dataset) {
  const observed = ipLookups.addresses[value];
  if (!observed && !dataset) return null;
  const kind = observed?.kind || dataset?.kind || null;
  const provider = observed?.provider || dataset?.provider || null;
  return {
    kind,
    label: provider || NETWORK_KIND_LABELS[kind] || kind,
    provider,
    country: observed?.country || null,
    country_name: observed?.country_name || null,
    isp: observed?.isp || null,
    org: observed?.org || null,
    asn: observed?.asn || null,
    hosting: !!observed?.hosting,
    proxy: !!observed?.proxy,
    mobile: !!observed?.mobile,
    note: observed?.note || null,
    checked: observed?.checked || null,
    looked_up_at: observed?.looked_up_at || null,
  };
}

/** Rows laid out at once for readers without JavaScript. See src/_data/limits.js. */
const FALLBACK_COUNT = require("./limits.js").list;

/** How many indicator pages `--serve` and `--watch` build. See indicatorPages(). */
const DEV_PAGE_LIMIT = 400;

/**
 * The records /indicators/{id}/ paginates over.
 *
 * One page per record means this list alone is ~97% of the site's output, and
 * rendering and writing all of it costs 37 seconds of the 38-second build — so
 * the dev server spends half a minute on pages nobody is looking at before it
 * answers a request. Under `--serve` and `--watch` this returns a slice, which
 * takes the same build to about 5 seconds. The slice is a stratified sample, up
 * to ceil(400 / number of types) records of each type, so the dev server shows
 * every kind of page rather than only the first types alphabetically.
 *
 * The gate is Eleventy's own ELEVENTY_RUN_MODE rather than an ELEVENTY_ENV the
 * repo would have to remember to set: `npm run build` and the deploy workflow
 * both run in "build" mode, so a truncated site cannot be published by
 * forgetting a variable. Set ELEVENTY_ALL_INDICATORS=1 to serve the full set
 * when working on the indicator pages themselves, where the missing ones
 * would show up as local 404s.
 */
const SITEMAP_CHUNK = 5000;
/** Types that were one `other` type before 27 September 2026; see indicator_redirects. */
const RENAMED_FROM_OTHER = new Set(["compromised_repository", "malicious_repository"]);
const RENAMED_ON = "2026-09-27";

/**
 * The day a record first reached this index: the earliest day a source was
 * read for it, or for a bulk-dataset citation, whose pull date moves with
 * every sync, the dataset's publication date.
 */
function firstIndexed(record) {
  const pulled = record.sources
    .filter((source) => source.context_origin !== "dataset")
    .map((source) => source.pulled_at)
    .filter(Boolean)
    .sort()[0];
  return String(pulled || record.first_seen || "").slice(0, 10) || null;
}
const SOURCE_DATES = readJsonIfPresent(
  path.join(__dirname, "..", "..", "scripts", "data", "source-dates.json"),
  { dates: {} }
).dates;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// LinkedIn prints "Joined July 2015"; kept to the month it states.
function joinedMonth(text) {
  const m = /^([a-z]+)\s+(\d{4})$/i.exec(String(text || "").trim());
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return month < 0 ? null : `${m[2]}-${String(month + 1).padStart(2, "0")}`;
}
const accountKey = (value) => String(value).split("/").filter(Boolean).pop().toLowerCase();

/**
 * For a value no dated report names, an account's creation date is a better
 * date than the day this site first recorded it (maintainer ruling,
 * 2026-10-12). A GitHub or LinkedIn account takes its own creation date; any
 * other value filed under a persona takes the persona's LinkedIn joined date,
 * or failing that its earliest GitHub creation date. A recycled GitHub login is
 * skipped: its creation date is the new holder's. Sets account_date and
 * account_kind ("linkedin" or "github"), which win over recorded_date.
 */
function accountDates(records) {
  const github = new Map();
  for (const a of readDataJson("github-account-status.json", { accounts: [] }).accounts || []) {
    if (a.state !== "recycled" && a.account_created) github.set(a.login.toLowerCase(), a.account_created);
  }
  for (const [login, a] of Object.entries(readDataJson("gh-analyzer.json", { accounts: {} }).accounts || {})) {
    if (a.created_at && !github.has(login.toLowerCase())) github.set(login.toLowerCase(), String(a.created_at).slice(0, 10));
  }
  const linkedin = new Map();
  for (const a of readDataJson("linkedin-account-status.json", { accounts: [] }).accounts || []) {
    const joined = joinedMonth(a.profile && a.profile.joined);
    if (joined) linkedin.set(a.slug.toLowerCase(), joined);
  }
  const own = (record) => {
    if (record.ioc_type === "github_profile") {
      const d = github.get(accountKey(record.value));
      return d ? { date: d, kind: "github" } : null;
    }
    if (record.ioc_type === "linkedin_profile") {
      const d = linkedin.get(accountKey(record.value));
      return d ? { date: d, kind: "linkedin" } : null;
    }
    return null;
  };
  const byPersona = new Map();
  for (const record of records) {
    const date = own(record);
    if (!date || !record.persona_key) continue;
    const held = byPersona.get(record.persona_key) || {};
    if (!held[date.kind] || date.date < held[date.kind]) held[date.kind] = date.date;
    byPersona.set(record.persona_key, held);
  }
  for (const record of records) {
    if (record.report_date) continue;
    const held = (record.persona_key && byPersona.get(record.persona_key)) || {};
    const date =
      own(record) ||
      (held.linkedin ? { date: held.linkedin, kind: "linkedin" } : null) ||
      (held.github ? { date: held.github, kind: "github" } : null);
    if (date) {
      record.account_date = date.date;
      record.account_kind = date.kind;
    }
  }
}

/**
 * The day a citation's page was published, or null. A date checked by hand in
 * scripts/data/source-dates.json wins. Otherwise the citation's own date counts
 * unless it is the day the source was read: a dossier or a candidate row dates
 * a page by the day it was transcribed, and a scraped citation falls back to
 * the day of the read, so a published date equal to pulled_at is a read date.
 * A bulk dataset's date is its publication date by construction.
 */
function publicationDate(source) {
  const curated = SOURCE_DATES[source.url];
  if (curated && /^\d{4}-\d{2}-\d{2}$/.test(curated.date || "")) return curated.date;
  const published = String(source.published || "").slice(0, 10);
  if (!published) return null;
  if (source.context_origin !== "dataset" && published === String(source.pulled_at || "").slice(0, 10)) return null;
  return published;
}

/**
 * Single pages whose record was retyped, by old id. The two Stack Overflow
 * profiles were filed as personal_site on 12 September 2026, before the
 * stackoverflow_account type existed, and were retyped on 28 September.
 */
const RETYPED_PAGES = [
  { from: "personal-site-5a27f884974c", type: "stackoverflow_account", value: "https://stackoverflow.com/users/20988762" },
  { from: "personal-site-dbaf5a6f4e60", type: "stackoverflow_account", value: "https://stackoverflow.com/users/22406929" },
];
const BROWSE_PAGE = require("./limits.js").browse;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function indicatorPages(records) {
  const watching = process.env.ELEVENTY_RUN_MODE === "serve" || process.env.ELEVENTY_RUN_MODE === "watch";
  if (!watching || process.env.ELEVENTY_ALL_INDICATORS) return records;
  // Records arrive sorted by type, so a plain slice would show only the first
  // few types. Take up to the same number from each type instead, keeping the
  // original order so the sample is deterministic.
  const types = [...new Set(records.map((record) => record.ioc_type))];
  const perType = Math.ceil(DEV_PAGE_LIMIT / types.length);
  const taken = {};
  return records.filter((record) => {
    taken[record.ioc_type] = (taken[record.ioc_type] || 0) + 1;
    return taken[record.ioc_type] <= perType;
  });
}

/**
 * What each indicator page calls its value, in the title, the lead sentence and
 * the browse listing. Keyed by ioc_type; a type missing here falls back to its
 * own name with the underscores taken out, so a new type still renders. The
 * plural heads the per-type browse listing, and is derived when not given.
 */
const TYPE_LABELS = {
  alias: ["alias", "Aliases"],
  asn: ["autonomous system number"],
  balkanfreelance_account: ["BalkanFreelance account"],
  calendly_account: ["Calendly account"],
  chrome_extension: ["Chrome extension"],
  codesandbox_account: ["CodeSandbox account"],
  cryptojobs_account: ["crypto.jobs account"],
  cryptojobslist_account: ["CryptoJobsList account"],
  devpost_account: ["Devpost account"],
  nineamworks_account: ["9am.works account"],
  devto_account: ["DEV Community account"],
  discord_account: ["Discord account"],
  dockerhub_account: ["Docker Hub account"],
  domain: ["domain"],
  email_address: ["email address"],
  ens_name: ["ENS name"],
  entre_account: ["Entre account"],
  f6s_account: ["F6S account"],
  facebook_account: ["Facebook account"],
  file_hash: ["file hash"],
  filename: ["file name"],
  fiverr_account: ["Fiverr account"],
  freelancer_account: ["Freelancer.com account"],
  freelancermap_account: ["freelancermap account"],
  github_dork: ["GitHub search query", "GitHub search queries"],
  github_profile: ["GitHub account"],
  gitlab_account: ["GitLab account"],
  hashnode_account: ["Hashnode account"],
  himalayas_account: ["Himalayas account"],
  hosted_site: ["hosted site"],
  huggingface_account: ["Hugging Face account"],
  instagram_account: ["Instagram account"],
  ip_address: ["IP address"],
  keybase_account: ["Keybase account"],
  klimbup_account: ["Klimbup account"],
  laborx_account: ["LaborX account"],
  linkedin_profile: ["LinkedIn account"],
  linktree_account: ["Linktree account"],
  medium_account: ["Medium account"],
  npm_package: ["npm package"],
  odnoklassniki_account: ["Odnoklassniki account"],
  compromised_repository: ["compromised repository", "Compromised repositories"],
  malicious_repository: ["malicious repository", "Malicious repositories"],
  other: ["indicator", "Other indicators"],
  payload_url: ["payload URL"],
  peerlist_account: ["Peerlist account"],
  personal_site: ["personal site"],
  phone_number: ["telephone number"],
  producthunt_account: ["Product Hunt account"],
  pypi_package: ["PyPI package"],
  quora_account: ["Quora account"],
  remotehub_account: ["RemoteHub account"],
  remoteok_account: ["Remote OK account"],
  skype_account: ["Skype account"],
  smart_contract_address: ["smart contract address"],
  stackoverflow_account: ["Stack Overflow account"],
  telegram_account: ["Telegram account"],
  torre_account: ["Torre account"],
  transaction_hash: ["transaction hash"],
  trello_account: ["Trello account"],
  upwork_account: ["Upwork account"],
  useme_account: ["Useme account"],
  username: ["username"],
  wallet_address: ["cryptocurrency wallet address"],
  wantedly_account: ["Wantedly account"],
  web3career_account: ["web3.career account"],
  x_account: ["X account"],
  youtube_account: ["YouTube account"],
  xing_account: ["XING account"],
};

/** Labels spelled with a consonant but read aloud starting with a vowel sound. */
const AN_PREFIXES = ["npm ", "X ", "F6S "];
/** Labels spelled with a vowel but read aloud starting with a consonant sound. */
const A_PREFIXES = ["upwork", "useme", "user", "uni", "eu", "one"];

function typeLabel(type) {
  const [label, plural] = TYPE_LABELS[type] || [type.replace(/_/g, " ")];
  const capital = label.charAt(0).toUpperCase() + label.slice(1);
  const an =
    (/^[aeiou]/i.test(label) && !A_PREFIXES.some((prefix) => label.toLowerCase().startsWith(prefix))) ||
    AN_PREFIXES.some((prefix) => label.startsWith(prefix));
  const heading = plural || (/(s|sh|ch|x)$/.test(label) ? capital + "es" : capital + "s");
  return {
    label,
    plural: heading,
    // The plural as it reads mid-sentence: "5,400 email addresses", but
    // "1,063 GitHub accounts".
    plural_text: /^[a-z]/.test(label) ? heading.charAt(0).toLowerCase() + heading.slice(1) : heading,
    article: an ? "an" : "a",
    slug: type.replace(/_/g, "-"),
  };
}

/** How many of a record's sources get a related list of their own. */
const SOURCE_GROUPS = 3;
/** How many related indicators one page links to, in all. */
const RELATED_LIMIT = 12;
/** How many of those come from the persona record when the value is also cited by a source. */
const RELATED_PERSONA_SHARE = 8;

/** A campaign label as it reads inside a sentence, where it differs from the label. */
const CAMPAIGN_PHRASES = { "DPRK (cluster unattributed)": "unclustered DPRK" };

function joinAnd(list) {
  if (list.length < 2) return list[0] || "";
  return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}

/**
 * The build's own date, as the machine running it reads the calendar. A pull
 * or check stamped in UTC can fall on tomorrow's date for a build running
 * west of Greenwich, and a sitemap must not claim a page changed in the
 * future, so no lastmod is later than this.
 */
function buildDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function latestDate(...dates) {
  const ceiling = buildDay();
  let latest = null;
  for (const date of dates) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    const day = date.slice(0, 10) > ceiling ? ceiling : date.slice(0, 10);
    if (!latest || day > latest) latest = day;
  }
  return latest;
}

/**
 * The fields /indicators/{id}/ renders beyond the record itself, so the page
 * reads as a page about one value rather than a template around it: what kind
 * of identifier it is, who published it, when the page last changed, and the
 * values it sits beside.
 *
 * `lastmod` is the latest date the page's own content moved: a citation this
 * site pulled, a source's publication date, or an account, network or line
 * check. The sitemap carries it. The build date would be wrong for every page
 * whose content did not change, and Google stops trusting a sitemap's dates
 * once it finds them wrong.
 *
 * `related` gives each page ordinary links to other indicator pages, with the
 * value as the anchor text: every other value filed under the same persona,
 * capped at the site's list limit, and the values either side of this one in
 * each of its first few sources, taken as a ring so that every page is linked
 * from its neighbours as well as linking to them. Without it an indicator page
 * is reached only through the browse listing. The entries are small shared
 * objects rather than the records themselves, so nothing here is circular.
 */
function indicatorPageData(records, personaIndicators) {
  const order = (a, b) => compareText(a.ioc_type, b.ioc_type) || compareText(a.value, b.value);
  const stubs = new Map();
  const stub = (record) => {
    if (!stubs.has(record)) {
      stubs.set(record, { id: record.id, value: record.value, type: typeLabel(record.ioc_type).label });
    }
    return stubs.get(record);
  };

  /**
   * A group of records that belong together (one source's citations, one
   * persona's identifiers), indexed once so that picking a page's neighbours is
   * a lookup. `members` is in type then value order, `types` holds one bucket
   * per type, and `at` gives each record's place in the group and in its bucket.
   */
  const makeGroup = (members) => {
    members.sort(order);
    const types = new Map();
    const at = new Map();
    members.forEach((member, position) => {
      if (!types.has(member.ioc_type)) types.set(member.ioc_type, []);
      const bucket = types.get(member.ioc_type);
      at.set(member, { position, slot: bucket.length });
      bucket.push(member);
    });
    const kinds = [...types.keys()].sort(compareText);
    return { members, types, kinds, at };
  };

  const bySource = new Map();
  for (const record of records) {
    for (const source of record.sources.slice(0, SOURCE_GROUPS)) {
      const key = source.url || source.title;
      if (!key) continue;
      if (!bySource.has(key)) bySource.set(key, []);
      const members = bySource.get(key);
      if (members[members.length - 1] !== record) members.push(record);
    }
  }
  const sourceGroups = new Map();
  for (const [key, members] of bySource) sourceGroups.set(key, makeGroup(members));
  bySource.clear();
  const personaGroups = new Map();
  const personaGroup = (slug) => {
    if (!personaGroups.has(slug)) personaGroups.set(slug, makeGroup([...((personaIndicators[slug] || {}).records || [])]));
    return personaGroups.get(slug);
  };

  /**
   * Up to `quota` members of `group` other than `record`, taken one type at a
   * time so a hash page shows the sample's domains and addresses as well as
   * other hashes, with the record's own type last. Each bucket is entered at a
   * point that depends on where the record sits, which spreads the links over
   * the whole group instead of sending every page to the same first twelve.
   */
  const pick = (group, record, quota, seen) => {
    const mine = group.at.get(record);
    const kinds = group.kinds.filter((kind) => kind !== record.ioc_type);
    if (group.types.has(record.ioc_type)) kinds.push(record.ioc_type);
    const picked = [];
    const longest = Math.max(...[...group.types.values()].map((bucket) => bucket.length));
    for (let round = 0; round < longest && picked.length < quota; round++) {
      for (const kind of kinds) {
        if (picked.length >= quota) break;
        const bucket = group.types.get(kind);
        if (round >= bucket.length) continue;
        const start = kind === record.ioc_type ? mine.slot + 1 : mine.position;
        const other = bucket[(start + round) % bucket.length];
        if (seen.has(other)) continue;
        seen.add(other);
        picked.push(other);
      }
    }
    return picked;
  };

  /** Picked records as small shared objects, grouped by type label in type then value order. */
  const byKind = (picked) => {
    const groups = [];
    for (const other of picked.sort(order)) {
      const label = typeLabel(other.ioc_type);
      const last = groups[groups.length - 1];
      if (last && last.slug === label.slug) last.items.push(stub(other));
      else groups.push({ slug: label.slug, label: label.plural, items: [stub(other)] });
    }
    return groups;
  };

  for (const record of records) {
    record.kind = typeLabel(record.ioc_type);
    const publishers = [];
    for (const source of record.sources) {
      let name = source.publisher;
      if (!name && source.url) {
        try {
          name = new URL(source.url).hostname.replace(/^www\./, "");
        } catch (err) {
          name = null;
        }
      }
      name = name || source.title;
      if (name && !publishers.includes(name)) publishers.push(name);
    }
    record.publishers = publishers;
    record.publishers_text = joinAnd(publishers);
    // How many distinct documents cite the value. `sources` holds one entry per
    // sighting, and a report that names a value twice is two sightings of it
    // but one source.
    record.source_count = new Set(record.sources.map((source) => source.url || source.title)).size;
    // The earliest publication date among the cited sources: the day a public
    // report first named the value. Never a day a source was read, and not
    // first_seen, which falls back to one. Null when no source carries a
    // publication date. Each citation's `published` is reduced to its
    // publication date here (see publicationDate), so the compact index and
    // ioc-search.js, which derive the same date from it, never see a read date.
    for (const source of record.sources) source.published = publicationDate(source);
    record.report_date = record.sources.map((source) => source.published).filter(Boolean).sort()[0] || null;
    // A value cited only from pages with no publication date (an account, a
    // registry profile, a portfolio) shows the day this site first recorded
    // it instead, marked as such (maintainer ruling, 2026-10-12).
    record.recorded_date = record.report_date ? null : firstIndexed(record);
    record.campaign_text = joinAnd((record.campaign || []).map((label) => CAMPAIGN_PHRASES[label] || label));
    record.lastmod = latestDate(
      record.last_seen,
      ...record.sources.map((source) => source.pulled_at),
      record.account_status?.checked,
      record.network_status?.checked,
      record.phone_status?.checked
    );

    const seen = new Set([record]);
    const sourceMatches = [];
    for (const source of record.sources.slice(0, SOURCE_GROUPS)) {
      const key = source.url || source.title;
      const group = key && sourceGroups.get(key);
      if (!group || group.members.length < 2 || sourceMatches.some((match) => match.key === key)) continue;
      sourceMatches.push({ key, source, group, picked: [] });
    }

    // The next value in the first source's own order is always linked, so the
    // sources' orderings form a ring and every page in a group is linked from
    // another one.
    if (sourceMatches.length) {
      const { group, picked } = sourceMatches[0];
      const next = group.members[(group.at.get(record).position + 1) % group.members.length];
      seen.add(next);
      picked.push(next);
    }
    let room = RELATED_LIMIT - seen.size + 1;

    const personaMatches = (record.personas || []).slice(0, 2).map((owner) => {
      const group = personaGroup(owner.slug);
      return { owner, group, picked: [] };
    });
    let personaRoom = sourceMatches.length ? Math.min(room, RELATED_PERSONA_SHARE) : room;
    personaMatches.forEach((match, i) => {
      if (!match.group.at.has(record)) return;
      const share = Math.ceil(personaRoom / (personaMatches.length - i));
      match.picked = pick(match.group, record, share, seen);
      personaRoom -= match.picked.length;
      room -= match.picked.length;
    });
    sourceMatches.forEach((match, i) => {
      const share = Math.ceil(room / (sourceMatches.length - i));
      const more = pick(match.group, record, share, seen);
      match.picked.push(...more);
      room -= more.length;
    });

    record.related = {
      personas: personaMatches.map(({ owner, group, picked }) => ({
        slug: owner.slug,
        name: owner.name || owner.slug,
        count: group.members.length - (group.at.has(record) ? 1 : 0),
        groups: byKind(picked),
        shown: picked.length,
      })).filter((list) => list.shown),
      sources: sourceMatches.map(({ source, group, picked }) => ({
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        count: group.members.length - 1,
        groups: byKind(picked),
        shown: picked.length,
      })).filter((list) => list.shown),
    };
  }

  for (const list of Object.values(personaIndicators)) {
    list.lastmod = latestDate(...list.records.map((record) => record.lastmod));
  }
}

/**
 * The browse listing, one run of pages per indicator type, so every page holds
 * one kind of value and says which in its title ("Email addresses, page 3 of
 * 27"). /indicators/ and /indicators/browse/ link to every run page, which puts
 * any indicator page three clicks from the home page: home, /indicators/, a run
 * page, the indicator.
 */
function browseRuns(pages) {
  const byType = new Map();
  for (const record of pages) {
    if (!byType.has(record.ioc_type)) byType.set(record.ioc_type, []);
    byType.get(record.ioc_type).push(record);
  }
  const types = [];
  for (const [type, members] of byType) {
    const kind = typeLabel(type);
    const base = `/indicators/browse/${kind.slug}/`;
    const at = (i) => (i ? `${base}${i + 1}/` : base);
    const runs = chunk(members, BROWSE_PAGE).map((run, i, all) => ({
      kind,
      number: i + 1,
      of: all.length,
      total: members.length,
      url: at(i),
      prev: i ? at(i - 1) : null,
      next: i + 1 < all.length ? at(i + 1) : null,
      first: run[0].value,
      last: run[run.length - 1].value,
      // The newest lastmod of the pages the run lists, for the sitemap: a
      // listing page changes when one of its entries does.
      lastmod: latestDate(...run.map((record) => record.lastmod)),
      records: run,
    }));
    types.push({ type, kind, total: members.length, url: base, runs, lastmod: latestDate(...runs.map((run) => run.lastmod)) });
  }
  types.sort((a, b) => b.total - a.total || compareText(a.kind.plural, b.kind.plural));
  return { types, runs: types.flatMap((entry) => entry.runs), lastmod: latestDate(...types.map((entry) => entry.lastmod)) };
}

/** A file under scripts/data/, which enrichment scripts and workflows write. */
function readDataJson(filename, fallback) {
  return readJsonIfPresent(path.join(__dirname, "..", "..", "scripts", "data", filename), fallback);
}

function readJson(filename, fallback) {
  return readJsonIfPresent(path.join(IOCS_DIR, filename), fallback);
}

/**
 * Labels that always travel together and should read as one
 * filter rather than two chips that select the identical set.
 *
 * EtherHiding is the technique and UNC5342 is the actor GTIG tracks using it —
 * not synonyms, which is why the merged label keeps both names rather than
 * picking one. Every entry carrying either carries both, so as filters they
 * were indistinguishable.
 */
const MERGED_CAMPAIGN_LABELS = {
  EtherHiding: "EtherHiding / UNC5342",
  UNC5342: "EtherHiding / UNC5342",
};

/**
 * Campaign labels are passed through as the source tagged them, with only the
 * merge above applied. Run once over every merged record in buildIndex(), so
 * a label reaches the page the same way whichever file carried it: a dossier
 * assigns its campaign directly, and four of its records once kept a bare
 * "EtherHiding" the rulesets had folded.
 *
 * An earlier version also SPLIT the combined taxonomy tag "Contagious Interview
 * / IT Worker Fraud" into two independent labels. That silently manufactured a
 * claim: DTEX's advisory is about IT workers and says nothing about Contagious
 * Interview, yet all 1,082 of its addresses ended up carrying that chip. Never
 * derive a second attribution from one the source actually made.
 */
function normalizeCampaigns(labels) {
  const out = [];
  for (const label of labels || []) {
    const merged = MERGED_CAMPAIGN_LABELS[label] || label;
    if (!out.includes(merged)) out.push(merged);
  }
  return out;
}

/**
 * A bulk dataset entry is a bare string sharing one dataset-level citation, so
 * it becomes a record with a single source and no context quote — there is no
 * per-entry prose in the source material to quote.
 *
 * Entries are used AS WRITTEN: no normalizer runs here, and the record id is
 * derived from the raw string. A dataset must therefore store values in the
 * form the matching normalizer emits, because the id is what deduplicates a
 * dataset entry against the same value found by the scraper. This never mattered
 * while every dataset held addresses and package names, which are already
 * lowercase. It bites the moment one holds a checksummed EVM address: DOJ's
 * forfeiture attachment prints them in mixed case, and carrying that casing
 * through produced a second record for all 19 addresses the scraper had also
 * matched, each with half the citations. Store them lowercased.
 */
/** Prose fields may be one string or a list of paragraphs; contexts want one string. */
function asText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ");
  return value || "";
}

function recordsFromDatasets(datasets) {
  const records = [];
  for (const dataset of datasets) {
    const pulledAt = dataset.sync?.last_synced || dataset.source?.date || null;
    // The report's publication date, not the day the sync last ran.
    const publishedAt = dataset.source?.date || pulledAt;
    for (const entry of dataset.entries || []) {
      records.push({
        id: recordId(dataset.ioc_type, entry),
        ioc_type: dataset.ioc_type,
        value: entry,
        display: null,
        persona: null,
        campaign: [...(dataset.campaign || [])],
        first_seen: publishedAt,
        last_seen: publishedAt,
        extraction: { method: "bulk-dataset", model: null, grounded: true },
        // A dataset that is itself a list of one service's exits (Spur's
        // Astrill list) labels every address it carries, whether or not the
        // address has been looked up individually.
        ...(dataset.network && dataset.ioc_type === "ip_address"
          ? { network_status: networkStatus(entry, dataset.network) }
          : {}),
        sources: [
          {
            url: dataset.source?.url || null,
            title: dataset.source?.title || dataset.title,
            publisher: dataset.source?.publisher || null,
            // A bulk dataset's citation date is its publication date; the
            // sync date is tracked separately as pulled_at.
            published: dataset.source?.date || null,
            // The dataset's own disclaimer, carried onto every record it
            // produces. Without it a bulk entry renders as a bare value beside
            // a campaign name, which for a compromised legitimate package reads
            // as an accusation against the victim -- axios@1.14.1 on its own
            // says the wrong thing about axios.
            // A dataset's prose may be written as an array of paragraphs (see
            // the `paragraphs` filter in .eleventy.js). A record's context is a
            // single quoted string, so flatten rather than stringify an array.
            context: asText(dataset.disclaimer) || asText(dataset.description) || "",
            context_origin: "dataset",
            pulled_at: pulledAt,
            source_sha256: null,
          },
        ],
      });
    }
  }
  return records;
}

/**
 * Indicator types in the curated rulesets that are search *queries* or
 * detection *patterns* rather than identifiers — a GitHub dork and a YARA rule
 * are not things a defender looks up in this index, and they read as noise
 * beside an email address or a package name.
 */
const NON_IDENTIFIER_TYPES = new Set(["github_dork", "c2_pattern"]);

/**
 * The hand-curated rulesets (repo-scan-ruleset.json, etherhiding-watchlist.json)
 * already carry exactly what this index wants: a value, a campaign, a written
 * explanation, and citations.
 *
 * These matter for package indicators in particular. Automated extraction
 * cannot reliably tell a malicious package from the legitimate one it
 * impersonates, or a malicious extension from the wallet it targets — a human
 * decided the polarity of every entry here, which is why they carry the
 * strongest provenance label on the page.
 */
function recordsFromRuleset(entries) {
  return (entries || [])
    .filter((entry) => entry.value && !NON_IDENTIFIER_TYPES.has(entry.ioc_type))
    .map((entry) => ({
      id: recordId(entry.ioc_type, entry.value),
      ioc_type: entry.ioc_type,
      value: entry.value,
      display: null,
      persona: null,
      campaign: [...(entry.campaign || [])],
      // Set on a curated entry whose link to North Korea the cited reporting
      // does not establish; the indicator page and the tracker say so.
      attribution_doubt: entry.attribution_doubt || null,
      first_seen: (entry.sources || []).map((x) => x.date).filter(Boolean).sort()[0] || entry.date_added || null,
      last_seen: (entry.sources || []).map((x) => x.date).filter(Boolean).sort().pop() || entry.date_added || null,
      extraction: { method: "curated", model: null, grounded: true },
      sources: (entry.sources || []).map((source) => ({
        url: source.url || null,
        title: source.title || null,
        publisher: source.publisher || null,
        published: source.date || null,
        // The curated description is the explanation a human wrote for why
        // this value is an indicator, which is exactly what the context slot
        // is for on every other record.
        context: asText(entry.description),
        context_origin: "curated",
        // The passage of the source itself that names the value, captured by
        // scripts/quote-watchlist-sources.js, so the page can show it as printed.
        excerpt: asText(source.quote) || null,
        pulled_at: entry.date_added || null,
        source_sha256: null,
      })),
    }));
}

function sourceKey(source) {
  return `${source.url} ${source.context || ""}`;
}

/**
 * One indicator present in both a bulk dataset and a scraped report becomes a
 * single record carrying both citations, so corroboration across independent
 * sources is visible on the page rather than showing up as a duplicate.
 */
function mergeRecords(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const record of group) {
      const existing = byId.get(record.id);
      if (!existing) {
        byId.set(record.id, { ...record, sources: [...record.sources], campaign: [...(record.campaign || [])] });
        continue;
      }
      absorb(existing, record);
    }
  }
  return [...byId.values()];
}

/** Folds `record`'s citations, dates, labels and statuses into `existing`. */
function absorb(existing, record) {
  const seen = new Set(existing.sources.map(sourceKey));
  for (const source of record.sources) {
    if (!seen.has(sourceKey(source))) {
      existing.sources.push(source);
      seen.add(sourceKey(source));
    }
  }
  if (record.first_seen && (!existing.first_seen || record.first_seen < existing.first_seen)) {
    existing.first_seen = record.first_seen;
  }
  if (record.last_seen && (!existing.last_seen || record.last_seen > existing.last_seen)) {
    existing.last_seen = record.last_seen;
  }
  for (const campaign of record.campaign || []) {
    if (!existing.campaign.includes(campaign)) existing.campaign.push(campaign);
  }
  if (!existing.display && record.display) existing.display = record.display;
  if (!existing.persona && record.persona) existing.persona = record.persona;
  if (!existing.attribution_doubt && record.attribution_doubt) existing.attribution_doubt = record.attribution_doubt;
  // A line-type lookup is attached by the dossier loader, which runs before
  // the scraped group; the same number reaching the index from a report as
  // well must not lose it to merge order.
  if (!existing.phone_status && record.phone_status) existing.phone_status = record.phone_status;
  if (!existing.network_status && record.network_status) existing.network_status = record.network_status;
  if (!existing.password && record.password) {
    existing.password = record.password;
    existing.password_origin = record.password_origin;
  }
  // Account liveness and a first-hand profile read are attached the same
  // way, and a LinkedIn address the ruleset held first must not lose the
  // read a later dossier carries for it. A read with a profile block
  // outranks a bare liveness check.
  if (record.account_status && (!existing.account_status || (record.account_status.profile && !existing.account_status.profile))) {
    existing.account_status = record.account_status;
  }
  // Provenance only ever strengthens: a hand-curated entry outranks a
  // scraped one, which outranks a bulk-list entry. Without this a record
  // that appears in DTEX's list too would lose its stronger label.
  // A third-party registry ranks with a researcher post: both are somebody
  // else's attributed claim about one operator. Without an entry here it
  // would default to 0 and lose to a bulk list, which is backwards — a
  // named per-persona dossier says more than an address on a flat list.
  const RANK = { "bulk-dataset": 0, llm: 1, "researcher-post": 1, registry: 1, regex: 2, curated: 3 };
  if ((RANK[record.extraction.method] || 0) > (RANK[existing.extraction.method] || 0)) {
    existing.extraction = record.extraction;
  }
}

/**
 * Types that name the same thing as another type for the same value, keyed
 * by the type that folds away, with the type that survives. A scraped
 * `hosted_site` whose value is a bare host is the curated `domain` of that
 * host, and a `wallet_address` a report printed is the `smart_contract_address`
 * the watchlist files for it. Two pages with the same value in the title split
 * whatever ranking the value earns and each hold half its citations. See
 * "Duplicate values" in docs/search-indexing.md.
 */
const FOLDED_TYPES = { hosted_site: "domain", wallet_address: "smart_contract_address" };

/**
 * Merges each folded record into its survivor, where the index holds one for
 * the same value, and returns the records left and a redirect from each folded
 * record's page to the survivor's.
 */
function foldDuplicateTypes(records) {
  const survivors = new Map();
  for (const record of records) {
    if (Object.values(FOLDED_TYPES).includes(record.ioc_type)) {
      survivors.set(`${record.ioc_type}|${String(record.value).toLowerCase()}`, record);
    }
  }
  const kept = [];
  const redirects = [];
  for (const record of records) {
    const into = FOLDED_TYPES[record.ioc_type];
    const survivor = into && survivors.get(`${into}|${String(record.value).toLowerCase()}`);
    if (!survivor) {
      kept.push(record);
      continue;
    }
    absorb(survivor, record);
    redirects.push({ from: record.id, to: survivor.id });
  }
  return { records: kept, redirects };
}

/** Every distinct source cited by any record, with how many indicators it accounts for. */
function collectSources(records) {
  const byUrl = new Map();
  for (const record of records) {
    for (const source of record.sources) {
      if (!source.url) continue;
      const existing = byUrl.get(pageKey(source.url));
      if (!existing) {
        byUrl.set(pageKey(source.url), {
          url: source.url,
          title: source.title || source.url,
          publisher: source.publisher || null,
          published: source.published || null,
          record_count: 1,
          last_pulled: source.pulled_at || null,
          ioc_types: new Set([record.ioc_type]),
          campaigns: new Set(record.campaign || []),
        });
        continue;
      }
      existing.record_count += 1;
      existing.ioc_types.add(record.ioc_type);
      (record.campaign || []).forEach((c) => existing.campaigns.add(c));
      if (source.pulled_at && (!existing.last_pulled || source.pulled_at > existing.last_pulled)) {
        existing.last_pulled = source.pulled_at;
      }
    }
  }
  return [...byUrl.values()]
    .map((source) => ({
      ...source,
      ioc_types: [...source.ioc_types].sort(),
      campaigns: [...source.campaigns].sort(),
    }))
    .sort((a, b) => b.record_count - a.record_count || compareText(a.title, b.title));
}

/**
 * The payload the browser actually downloads, emitted by src/ioc-index.njk.
 *
 * Keys are single letters and every repeated source URL, title and publisher
 * is replaced by an index into a lookup table. At the ~10,000-record scale
 * this index is built for, that repetition is most of the bytes — collapsing
 * it is the difference between a few hundred KB and several megabytes.
 */
function compactIndex(records, generatedAt) {
  const types = [];
  const methods = [];
  const sources = [];
  const sourceIndex = new Map();
  // Context quotes are 57% of this payload and a quarter of them are repeats:
  // one sentence in a report is the context for every value the extractor
  // found in it, and writing it out per record cost 1.2MB of the 5MB the
  // browser downloads. They go in a lookup table for the same reason the
  // source metadata already does.
  const contexts = [];
  const contextIndex = new Map();

  const indexOf = (list, value) => {
    let at = list.indexOf(value);
    if (at === -1) at = list.push(value) - 1;
    return at;
  };

  const compactRecords = records.map((record) => ({
    i: record.id,
    t: indexOf(types, record.ioc_type),
    v: record.value,
    d: record.display || null,
    // Which search surface the record belongs to. The one index is shared by the
    // /remote-workers/ page and the cluster pages; the former filters to its own
    // areas client-side (data-ioc-area, a space-separated list), so espionage
    // records ride along for the cluster searches without showing up in the
    // remote-worker search.
    r: record.area || "remote-workers",
    p: record.persona?.name || null,
    k: record.campaign || [],
    c: record.persona?.confidence || null,
    // The persona page this indicator lives on, where it has exactly one. A
    // search result links straight there rather than to a page of its own; the
    // renderer in ioc-search.js builds the anchor from this and `i`. Null for a
    // record with no persona or with more than one, which keeps its own page.
    h: record.persona_slug || null,
    e: indexOf(methods, record.extraction.method),
    x: record.extraction.model || null,
    g: record.extraction.grounded ? 1 : 0,
    a: record.account_status || null,
    // LIVE MALWARE or TAKEN DOWN for a malicious repository or package.
    m: record.malware_status ? record.malware_status.state : null,
    mc: record.malware_status ? record.malware_status.checked : null,
    f: record.first_seen || null,
    l: record.last_seen || null,
    // For a value no dated source names: an account creation date where the
    // value or its persona has one, else the day this site first recorded it.
    // The Report date column shows it with a marker naming which.
    rr: record.report_date ? null : record.account_date || record.recorded_date || record.first_seen || null,
    // Where rr comes from when it is an account date: "linkedin" (joined) or
    // "github" (created); absent for the day this site recorded the value.
    rk: record.report_date ? null : record.account_kind || null,
    // The password an address was reported with, and its reuse-cluster id
    // where another address shares it. Both are searchable, so typing either
    // pulls every account that used it.
    w: [record.password, record.password_group].filter(Boolean).join(" ") || null,
    // Network kind and provider for an IP address, as a chip on the row and a
    // word in the haystack, so "astrill" or "data centre" finds them.
    n: record.network_status ? [record.network_status.kind, record.network_status.label] : null,
    s: record.sources.map((source) => {
      const key = source.url || source.title || "";
      if (!sourceIndex.has(key)) {
        sourceIndex.set(key, sources.length);
        sources.push({
          u: source.url || null,
          t: source.title || null,
          p: source.publisher || null,
          d: source.published || null,
        });
      }
      const context = source.context || "";
      if (!contextIndex.has(context)) {
        contextIndex.set(context, contexts.length);
        contexts.push(context);
      }
      return [sourceIndex.get(key), contextIndex.get(context), source.pulled_at || null, source.section || null, source.context_origin || "text"];
    }),
  }));

  // v2 moved position 1 of a source entry from the quote itself to an index
  // into the contexts table. Anything reading this file has to resolve it.
  return { v: 2, generated_at: generatedAt, types, methods, sources, contexts, records: compactRecords };
}

/**
 * The search file's copy of a compact index: no `contexts` table, and no key
 * whose value is null, `[]`, 0 or the default area. `t` and `e` are kept
 * at 0: they index the types and methods tables, so 0 is the first entry, not
 * an absent value, and dropping it left every record of the first type without
 * one, which threw in ioc-search.js and emptied every search. ioc-search.js reads every
 * key through `|| null`, `|| []` or `|| "remote-workers"`, so an absent key
 * behaves exactly as the value it stands for, and the file is much smaller
 * for it. The full index (/assets/data/ioc-index.json) keeps every key.
 */
const INDEX_KEYS = new Set(["t", "e"]);

function searchCore(compact) {
  const records = compact.records.map((record) => {
    const out = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === null || (value === 0 && !INDEX_KEYS.has(key))) continue;
      if (key === "r" && value === "remote-workers") continue;
      if (key === "k" && value.length === 0) continue;
      out[key] = value;
    }
    return out;
  });
  return { ...compact, contexts: undefined, records };
}

/**
 * The full index as CSV, for the download on /remote-workers/.
 *
 * Defenders cross-check these against HR exports and SIEM data, and a
 * spreadsheet is a more useful hand-off than the compact JSON the search UI
 * consumes — that payload uses one-letter keys and index references into a
 * lookup table, which is right for the browser and wrong for a human.
 * Generated at build time, so the download is a static file.
 */
function toCsv(records) {
  const cell = (value) => {
    let text = value === null || value === undefined ? "" : String(value);
    // A cell a spreadsheet would read as a formula gets a leading apostrophe,
    // the OWASP mitigation for CSV injection: researchers' quoted text flows
    // into these columns. A signed plain number such as a phone is left alone.
    if (/^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[0-9 ().-]+$/.test(text))) text = "'" + text;
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const rows = [
    ["value", "ioc_type", "persona", "account_status", "network", "campaigns", "first_seen",
     "last_seen", "provenance", "model", "source_urls", "source_titles", "context"].join(","),
  ];
  for (const record of records) {
    rows.push([
      record.value,
      record.ioc_type,
      record.persona?.name || "",
      record.account_status?.state || "",
      record.network_status?.label || "",
      (record.campaign || []).join("; "),
      record.first_seen,
      record.last_seen,
      record.extraction.method,
      record.extraction.model,
      record.sources.map((s) => s.url).filter(Boolean).join(" | "),
      record.sources.map((s) => s.title).filter(Boolean).join(" | "),
      record.sources.map((s) => s.context).filter(Boolean).join(" | "),
    ].map(cell).join(","));
  }
  return rows.join("\n");
}

/**
 * The remote-worker index as CSV, split one file per `ioc_type`.
 *
 * A reader who wants "just the email addresses" or "just the IPs" for the
 * whole dataset, not only what the client-side search has currently matched,
 * gets a static, linkable file that works with no JavaScript — the same
 * `toCsv` columns as the single combined download, just pre-filtered.
 * Generated once at build time from records already held in memory, so this
 * costs one extra pass per type rather than a second read of the source data.
 */
function toCsvByType(records) {
  const byType = new Map();
  for (const record of records) {
    if (!byType.has(record.ioc_type)) byType.set(record.ioc_type, []);
    byType.get(record.ioc_type).push(record);
  }
  const out = {};
  for (const [type, group] of byType) out[type] = toCsv(group);
  return out;
}

function buildIndex() {
  // Held separately as well as merged in, because /remote-workers/ excludes it:
  // see the `area` assignment below.
  const polinriderRepos = readJson("polinrider-affected-repos.json", []);
  const datasets = [
    ...readJson("itworker-datasets.json", []),
    ...polinriderRepos,
    ...readJson("osm-malicious-package-versions.json", []),
    // The same shape as the file above, for every publisher other than
    // OpenSourceMalware. That file is named for its source and holds only its
    // datasets; a Sonatype package list filed there would be mislabelled by the
    // filename alone. Version-pinned package releases arrive from enough vendors
    // to be worth a general home.
    ...readJson("malicious-package-versions.json", []),
  ];
  const scraped = readJson("scraped-iocs.json", { records: [] });
  const repoScan = readJson("repo-scan-ruleset.json", []);
  const etherhiding = readJson("etherhiding-watchlist.json", []);
  // Persona dossiers transcribed by hand from researcher posts on X, which the
  // scraper cannot reach — see scripts/lib/dossiers.js for why.
  // Three files share the dossier schema and loader: hand-transcribed X posts,
  // third-party registries that publish the same per-persona shape, and values
  // this repository observed directly on a live account. They differ only in
  // the provenance label their records carry.
  const dossiers = [
    ...recordsFromDossiers(readJson("x-dossiers.json", null)),
    ...recordsFromDossiers(readJson("third-party-registries.json", null)),
    ...recordsFromDossiers(readJson("direct-observations.json", null)),
  ];

  // A confirmed candidate row is filed as a persona (scripts/lib/candidates.js),
  // so the persona grouping below reads these too.
  const candidateRecords = recordsFromCandidates(readJson("candidates.json", null));

  // Order matters: the first group to claim an id sets the record's provenance
  // label, and a human-curated entry outranks a scraped or bulk-list one.
  const merged = mergeRecords(
    recordsFromRuleset([...repoScan, ...etherhiding]),
    dossiers,
    scraped.records || [],
    recordsFromDatasets(datasets),
    // Reviewed candidates, last: their label ranks below everything, so a
    // value another source holds keeps that source's label.
    candidateRecords
  );
  const folded = foldDuplicateTypes(merged);
  const records = folded.records.sort(
    (a, b) => compareText(a.ioc_type, b.ioc_type) || compareText(a.value, b.value)
  );
  for (const record of records) {
    // "EtherHiding" folds into the UNC5342 label, except on a value no
    // published source ties to North Korea: the tracker covers every
    // EtherHiding operation, and naming a DPRK cluster there would claim one.
    record.campaign = record.attribution_doubt
      ? [...new Set(record.campaign || [])]
      : normalizeCampaigns(record.campaign);
    // One spelling of each publisher's name; see scripts/lib/publishers.js.
    // A source object can be shared between records, so it is replaced
    // rather than edited.
    record.sources = record.sources.map((source) => {
      const publisher = canonicalPublisher(source.url, source.publisher);
      return publisher === source.publisher ? source : { ...source, publisher };
    });
  }

  // What kind of network an address is on, for every IP indicator that has
  // been looked up. A record that reached the index from Spur's list already
  // carries the Astrill label; the lookup adds the announcing network beneath it.
  for (const record of records) {
    if (record.ioc_type !== "ip_address") continue;
    const status = networkStatus(record.value, record.network_status);
    if (status) record.network_status = status;
  }

  // When a domain was registered, for every domain-like indicator whose host
  // is itself a registered domain. See scripts/enrich-domains.js.
  for (const record of records) {
    if (record.ioc_type !== "domain" && record.ioc_type !== "hosted_site" && record.ioc_type !== "personal_site") continue;
    const registration = registrationFor(record.value);
    if (registration) record.registration = registration;
  }

  // Tag every indicator with the persona the report filed it under, so a
  // search result says which fabricated identity it belongs to and links to
  // that persona's page. The same grouping builds those pages, so the two can
  // never disagree. Only the scraped records carry section headings; a bulk
  // dataset lists addresses with no identity attached and stays untagged.
  const personas = buildPersonas([...(scraped.records || []), ...dossiers, ...candidateRecords]);
  const personaTags = personaByValue(personas);
  for (const record of records) {
    const tag = personaTags.get(record.value);
    if (tag) record.persona = tag;
  }

  // Where an indicator actually lives, for every link on the site that points at
  // one.
  //
  // An indicator that belongs to a persona was reachable two ways, and the two
  // said different things about the same value: a page of its own under
  // /indicators/, and a row in the persona's identifier table that linked to it.
  // A reader following a result for an address already listed on Gary Lee's page
  // landed on a third page holding the same address, one citation and a link
  // back. The persona page is the one with the operator, the accounts, the
  // photographs and the CV on it, so it is where the site's result rows and
  // searches send a reader. The indicator keeps an indexable page of its own as
  // well, because a search engine matching an exact value needs a page whose
  // title and heading are that value; see indicatorPageData() below.
  //
  // Only a value with exactly one persona gets a home. A value two personas
  // share — an IP address both are hosted behind, an address a researcher filed
  // under two names — has no single page that holds it, so the result rows go
  // to its own page, which is where those personas are listed side by side.
  const personaOwners = personasByValue(personas);
  const personaIndicators = {};
  for (const record of records) {
    const owners = personaOwners.get(record.value) || [];
    if (!owners.length) continue;
    record.personas = owners;
    if (owners.length === 1) {
      record.persona_slug = owners[0].slug;
      record.persona_home = `/remote-workers/personas/${owners[0].slug}/#ioc-${record.id}`;
    }
    for (const owner of owners) {
      if (!personaIndicators[owner.slug]) personaIndicators[owner.slug] = { records: [], by_value: {} };
      personaIndicators[owner.slug].records.push(record);
      // The LinkedIn accounts are rendered in their own section of the persona
      // page, from the grouping rather than from here, and look their own record
      // up by URL to carry its anchor and citations.
      personaIndicators[owner.slug].by_value[record.value] = record;
    }
  }

  // The indexed records each candidate page links to, keyed by the candidate's
  // slug. recordsFromCandidates() cites a row's own page, so the citation URL
  // is what ties a record back to it.
  const candidateIndicators = {};
  const CANDIDATE_PAGE = /^https:\/\/chollimahunter\.github\.io\/remote-workers\/candidates\/([^/]+)\/$/;
  for (const record of records) {
    for (const source of record.sources) {
      const m = CANDIDATE_PAGE.exec(source.url || "");
      if (!m) continue;
      (candidateIndicators[m[1]] = candidateIndicators[m[1]] || []).push({ id: record.id, value: record.value, ioc_type: record.ioc_type });
      break;
    }
  }

  // Password-reuse linkage. build-password-links.js turns the Raven File
  // infostealer sample table into a graph of which accounts reused a password,
  // keyed by a one-way fingerprint so no credential is stored. Two emails
  // sharing a fingerprint are very likely one operator; that relation is the
  // indicator, and the plaintext deliberately is not (see docs). Attaching it
  // here lets the fingerprint be searched to pull a cluster, and lets each
  // account's page name the others it shares a password with.
  // Liveness for accounts on platforms other than GitHub and LinkedIn, for a
  // scraped record that did not come through the dossier loader (which
  // attaches the same status itself). See scripts/lib/platform-status.js.
  for (const record of records) {
    if (record.account_status) continue;
    const status = platformAccountStatus(record.ioc_type, record.value);
    if (status) record.account_status = status;
  }
  accountDates(records);
  // Whether a malicious repository or package is still online, and the OSV
  // MAL- advisories held for a package; see scripts/lib/malware-status.js and
  // scripts/lib/osv-malicious.js.
  for (const record of records) {
    const status = malwareStatus(record.ioc_type, record.value);
    if (status) record.malware_status = status;
    const advisories = osvAdvisories(record.ioc_type, record.value);
    if (advisories) record.osv_advisories = advisories;
  }
  // gh-fake-analyzer's signals for a GitHub account, with the addresses and
  // accounts it names resolved to their pages here where the index holds
  // them. See docs/gh-fake-analyzer.md.
  {
    const analysis = readDataJson("gh-analyzer.json", { accounts: {} }).accounts || {};
    const byValue = new Map(records.map((r) => [String(r.value).toLowerCase(), r]));
    const linkTo = (value) => {
      const hit = byValue.get(String(value).toLowerCase());
      return hit ? { value: hit.value, id: hit.id } : null;
    };
    const accounts = (logins) => (logins || []).map((l) => linkTo("https://github.com/" + l)).filter(Boolean);
    for (const record of records) {
      if (record.ioc_type !== "github_profile") continue;
      const login = String(record.value).replace(/^https:\/\/github\.com\//, "").toLowerCase();
      const a = analysis[login];
      if (!a || a.status) continue;
      const indexedEmails = (a.commit_emails || []).map(linkTo).filter(Boolean);
      record.gh_analysis = {
        analyzed: a.analyzed,
        tool: a.tool,
        created_at: a.created_at ? String(a.created_at).slice(0, 10) : null,
        original_repos: a.original_repos,
        forked_repos: a.forked_repos,
        backdated_repos: a.backdated_repos || 0,
        backdated_examples: a.backdated_examples || [],
        duplicate_commit_repos: a.duplicate_commit_repos || 0,
        identities: { emails: (a.commit_emails || []).length, names: (a.commit_names || []).length },
        names_per_email_max: a.names_per_email_max || 0,
        emails_per_name_max: a.emails_per_name_max || 0,
        dprk_naming: a.dprk_naming || [],
        emails_indexed: indexedEmails,
        emails_other: (a.commit_emails || []).length - indexedEmails.length,
        following_indexed: accounts(a.following_indexed),
        followers_indexed: accounts(a.followers_indexed),
        mutual_indexed: accounts(a.mutual_indexed),
      };
    }
  }

  const passwordLinks = readJson("password-links.json", { clusters: {}, by_email: {}, passwords: {} });
  for (const record of records) {
    if (record.ioc_type !== "email_address") continue;
    const password = (passwordLinks.passwords || {})[record.value.toLowerCase()];
    if (password) {
      record.password = password;
      record.password_origin = "infostealer";
    }
    const fp = passwordLinks.by_email[record.value.toLowerCase()];
    if (!fp) continue;
    record.password_group = fp;
    record.password_siblings = (passwordLinks.clusters[fp] || [])
      .filter((email) => email !== record.value.toLowerCase())
      .map((email) => ({ value: email, id: recordId("email_address", email) }));
  }

  // Which page a record is searchable on. EtherHiding indicators are on-chain
  // infrastructure rather than the identity indicators /remote-workers/ is
  // built around, so they are indexed on /etherhiding/ instead and excluded
  // from that page's search, chips and downloads.
  //
  // Area is decided by which file an indicator came from, and assigned after
  // the merge rather than carried through it. Deciding it per group would make
  // the label depend on merge order the moment the same value appeared in two
  // files, which is exactly the kind of silent inconsistency mergeRecords
  // exists to avoid.
  //
  // Note this cuts across campaign: the watchlisted contracts are tagged
  // Contagious Interview, which /remote-workers/ also covers. The split is by
  // indicator kind, not by cluster, and /remote-workers/ links across so the
  // absence is stated rather than silent.
  //
  // The PolinRider compromised-repository list is split off for the same
  // reason. Those entries are repository names of projects that were
  // themselves attacked, not identifiers of the people running the operation,
  // and there are enough of them to dominate an identity index by count while
  // answering a different question. They keep their own indicator pages, still
  // count toward their citation, and are searchable on the repo scanner, which
  // has a purpose-built search for them, and on /remote-workers/, where they
  // appear as the compromised repository type.
  const etherhidingIds = new Set(recordsFromRuleset(etherhiding).map((record) => record.id));
  const polinriderIds = new Set(recordsFromDatasets(polinriderRepos).map((record) => record.id));

  // /remote-workers/ is the operators' own identities and the lures run to reach
  // them, not DPRK espionage at large. A record whose only cluster is an APT
  // campaign -- Lazarus, Kimsuky, APT37, Konni, APT38, Andariel, Moonstone
  // Sleet, or unattributed DPRK -- is a heist or intrusion indicator that
  // answers a different question and, by count, would swamp the identity index
  // it is filed next to. Those move to their own `espionage` area: kept in the
  // search index (so the cluster pages that group them can still be searched)
  // and given their own pages, but dropped from the /remote-workers/ page's
  // counts, cluster chips, download and default search. A record carrying any
  // IT-worker cluster, or none at all (the dossier personas), stays put.
  const ESPIONAGE_CAMPAIGNS = new Set([
    "Lazarus Group",
    "Kimsuky",
    "APT37",
    "Konni",
    "APT38",
    "Andariel",
    "Moonstone Sleet",
    "DPRK (cluster unattributed)",
  ]);
  // Espionage only when every cluster the record carries is an APT one. A record
  // a report tags both "IT Worker Fraud" and "Lazarus Group" is a genuine
  // remote-worker indicator that also touches a heist, and stays; a record whose
  // only clusters are APT ones is a pure intrusion indicator and moves out. This
  // deliberately leaves PolinRider- and EtherHiding-campaign records where they
  // were, since those areas are decided by indicator kind, not by cluster.
  const isEspionageOnly = (record) => {
    const campaigns = record.campaign || [];
    if (campaigns.length === 0) return false;
    return campaigns.every((campaign) => ESPIONAGE_CAMPAIGNS.has(campaign));
  };

  for (const record of records) {
    record.area = etherhidingIds.has(record.id)
      ? "etherhiding"
      : polinriderIds.has(record.id)
        ? "polinrider"
        : isEspionageOnly(record)
          ? "espionage"
          : "remote-workers";
  }
  const remoteWorkerRecords = records.filter((record) => record.area === "remote-workers");
  const etherhidingRecords = records.filter((record) => record.area === "etherhiding");
  const polinriderRecords = records.filter((record) => record.area === "polinrider");
  const espionageRecords = records.filter((record) => record.area === "espionage");

  // The client-side search index carries the identity indicators and the
  // espionage ones together, so a cluster page scoped to Lazarus or Kimsuky can
  // still search its own records; the /remote-workers/ page narrows to its own
  // area with data-ioc-area. The PolinRider compromised-repository records ride
  // along too: /remote-workers/ names them in data-ioc-area, and the cluster and
  // home page searches drop them client-side (applyScope in ioc-search.js).
  // /repo-scanner/ searches them through its own index. The EtherHiding
  // records ride along so the home page and cluster searches find a contract,
  // wallet or C2 host; /remote-workers/ leaves them out through data-ioc-area.
  const searchableRecords = [...remoteWorkerRecords, ...espionageRecords, ...polinriderRecords, ...etherhidingRecords];
  // What /remote-workers/ searches: its own area plus the PolinRider records.
  // The chip counts below describe this set, so "All types (N)" equals what an
  // empty search returns; the CSV, JSON and per-type downloads stay on
  // remoteWorkerRecords.
  const pageSearchRecords = [...remoteWorkerRecords, ...polinriderRecords];

  // Chips read these in object order, so order them the way a reader scans:
  // biggest group first, right next to the "all" chip, ties alphabetical.
  const byCountDesc = (counts) =>
    Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    );

  // What /repo-scanner/ searches: the repository side of the corpus. That is
  // the hand-curated repo-scan ruleset (attacker-published package names, lure
  // filenames, C2 domains and wallet addresses) together with the PolinRider
  // affected-repository list, which no other search carries. The ruleset
  // records also stay in the remote-worker index; the two payloads are built
  // separately so neither page downloads the other's records.
  const repoScanIds = new Set(recordsFromRuleset(repoScan).map((record) => record.id));
  const repoScannerRecords = records.filter(
    (record) => record.area === "polinrider" || repoScanIds.has(record.id)
  );
  const repoCountsByType = {};
  const repoCountsByCampaign = {};
  for (const record of repoScannerRecords) {
    repoCountsByType[record.ioc_type] = (repoCountsByType[record.ioc_type] || 0) + 1;
    for (const campaign of record.campaign || []) {
      repoCountsByCampaign[campaign] = (repoCountsByCampaign[campaign] || 0) + 1;
    }
  }

  const countsByType = {};
  const countsByCampaign = {};
  // Only accounts have a liveness state, and only some of those have been
  // checked. An address or a package name is not an account and never counts
  // here, so these totals are deliberately much smaller than the type counts.
  const countsByStatus = {};
  for (const record of remoteWorkerRecords) {
    countsByType[record.ioc_type] = (countsByType[record.ioc_type] || 0) + 1;
    for (const campaign of record.campaign || []) {
      // A record a report dual-tags with an APT cluster stays here, but the page
      // does not offer that cluster as a filter chip: /remote-workers/ is the
      // identity view, and the espionage clusters have their own pages.
      if (ESPIONAGE_CAMPAIGNS.has(campaign)) continue;
      countsByCampaign[campaign] = (countsByCampaign[campaign] || 0) + 1;
    }
    const state = record.account_status?.state;
    if (state) countsByStatus[state] = (countsByStatus[state] || 0) + 1;
  }

  const searchCountsByType = {};
  const searchCountsByCampaign = {};
  for (const record of pageSearchRecords) {
    searchCountsByType[record.ioc_type] = (searchCountsByType[record.ioc_type] || 0) + 1;
    for (const campaign of record.campaign || []) {
      if (ESPIONAGE_CAMPAIGNS.has(campaign)) continue;
      searchCountsByCampaign[campaign] = (searchCountsByCampaign[campaign] || 0) + 1;
    }
  }

  // Newest first, and an individually-cited record ahead of a bulk-list entry
  // of the same date, so the no-JS sample shows the richest records available.
  const recent = [...remoteWorkerRecords]
    .sort(
      (a, b) =>
        compareText(b.last_seen || "", a.last_seen || "") ||
        Number(a.extraction.method === "bulk-dataset") -
          Number(b.extraction.method === "bulk-dataset") ||
        compareText(a.value, b.value)
    )
    .slice(0, FALLBACK_COUNT);

  const generatedAt = scraped.generated_at || null;

  indicatorPageData(records, personaIndicators);

  // Ordered by type and then value so the browse listing reads as a directory
  // rather than as the order the source files happened to be read in.
  const ownPages = indicatorPages(
    [...records].sort((a, b) => compareText(a.ioc_type, b.ioc_type) || compareText(a.value, b.value))
  );
  const browse = browseRuns(ownPages);

  return {
    // Every record, both areas. /indicators/{id}/ is built from this and the
    // source registry counts from it, so an indicator keeps its own page and
    // still counts toward its citation's tally whichever page searches it.
    records,
    sources: collectSources(records),
    // Hosts the operators run, which no page links to; see
    // scripts/lib/operator-hosts.js and the isOperatorSite filter.
    operator_hosts: operatorHosts(records),
    generated_at: generatedAt,

    // One count per searchable surface, plus the site-wide total. The homepage
    // and /indicators/ both state the full figure, so it has to be derived from
    // `records` rather than from any one area: quoting remote_workers.total as
    // if it were everything understated the site by the 2,400-odd repository
    // entries and the EtherHiding contracts, which are indexed, cited and given
    // their own pages exactly like the rest.
    totals: {
      all: records.length,
      remote_workers: remoteWorkerRecords.length,
      espionage: espionageRecords.length,
      etherhiding: etherhidingRecords.length,
      polinrider: polinriderRecords.length,
    },

    // What /indicators/{id}/ paginates over: every record in a production
    // build, a slice under --serve. Kept separate from `records` above so the
    // homepage count, the source tallies and the searches all keep describing
    // the full set even when the dev server is only building part of it.
    //
    // Every record gets a real, indexable page, including the ones that also
    // appear on a persona page. Those used to be noindex redirect stubs to the
    // persona page, which left a search for the exact value to a page titled
    // with a persona's name and holding dozens of other values; a page whose
    // title, heading and description are the value is what a search for it
    // should land on. The persona page links to each of them, and each links
    // back. See docs/search-indexing.md.
    indicator_pages: ownPages,

    // The same pages cut into fixed-size runs, for the two places that list
    // them all. A crawler reaches /indicators/{id}/ through these and nothing
    // else: the searches build their results in the browser, so without a
    // rendered link to each page a search engine has only the sitemap's word
    // that it exists, and a page nothing links to is the last one it fetches.
    // The sitemap runs are sized well under the 50,000-URL ceiling so each is
    // small enough to fetch quickly and report on separately in Search Console.
    // The browse runs are a page of links each, one run per indicator type,
    // under /indicators/browse/{type}/; `indicator_browse_types` is the
    // directory of them that /indicators/ and /indicators/browse/ render.
    indicator_sitemaps: chunk(ownPages, SITEMAP_CHUNK),

    // Old addresses of pages whose type was renamed. A page's id is its type
    // and a digest of type and value, so a new type moves the page. Repository
    // indicators were typed `other` until 27 September 2026, when they were
    // split into compromised_repository (the PolinRider victims) and
    // malicious_repository (the attackers' own); their old /indicators/other-…/
    // addresses had been published for two days, so each keeps a stub that
    // sends the reader and search engines on. Only a record indexed by then
    // had such an address; one added later never did, and a stub for it would
    // be a page at a URL nothing ever linked to.
    //
    // A value filed under two types that name the same thing is one page; the
    // folded type's address redirects to it. See foldDuplicateTypes().
    indicator_redirects: indicatorPages(
      records
        .filter((r) => RENAMED_FROM_OTHER.has(r.ioc_type))
        .filter((r) => {
          const day = firstIndexed(r);
          return day && day <= RENAMED_ON;
        })
        .map((r) => ({ from: recordId("other", r.value), to: r.id }))
        .concat(folded.redirects)
        .concat(
          RETYPED_PAGES.map((p) => ({ from: p.from, to: recordId(p.type, p.value) })).filter((p) =>
            records.some((r) => r.id === p.to)
          )
        )
    ),
    indicator_browse_pages: browse.runs,
    indicator_browse_types: browse.types,
    // The newest lastmod of any indicator page, for the hub pages that list
    // them (/indicators/ and /indicators/browse/) in the sitemap.
    indicator_lastmod: browse.lastmod,

    // The merged records each persona page lists, keyed by slug. The persona
    // pages are built from the `personas` data file, which groups the raw
    // dossier and scraped records; these are the same indicators AFTER the
    // merge, so the citations shown beside one on a persona page are the same
    // full set its own page used to show -- including a bulk dataset that
    // corroborates it, which the grouping never sees.
    persona_indicators: personaIndicators,

    // The indexed records each /remote-workers/candidates/{slug}/ page links.
    candidate_indicators: candidateIndicators,

    // What /remote-workers/ searches, counts and offers for download. These
    // three have to describe the same set: a download labelled with a total
    // the search does not return is a bug a reader finds before we do.
    remote_workers: {
      records: remoteWorkerRecords,
      recent,
      counts_by_type: byCountDesc(countsByType),
      counts_by_campaign: byCountDesc(countsByCampaign),
      counts_by_status: byCountDesc(countsByStatus),
      total: remoteWorkerRecords.length,
      // The same counts over what the page's search returns, which also holds
      // the PolinRider compromised repositories; these feed the filter chips.
      search_total: pageSearchRecords.length,
      search_counts_by_type: byCountDesc(searchCountsByType),
      search_counts_by_campaign: byCountDesc(searchCountsByCampaign),
      lastmod: latestDate(...remoteWorkerRecords.map((record) => record.lastmod)),
      // The shared search index carries espionage records too, tagged by area,
      // so cluster pages can search them; the page itself filters to its area.
      compact: compactIndex(searchableRecords, generatedAt),
      // The same payload split for the search UI: contexts are 42% of the
      // bytes and only matter once someone searches for a phrase, so they
      // travel in a second file the browser fetches after search is live.
      // See src/ioc-index-core.njk and src/ioc-index-contexts.njk.
      compact_core: searchCore(compactIndex(searchableRecords, generatedAt)),
      compact_contexts: { v: 2, generated_at: generatedAt, contexts: compactIndex(searchableRecords, generatedAt).contexts },
      csv: toCsv(remoteWorkerRecords),
      // One static CSV per indicator type, for the full dataset rather than
      // whatever the client-side search has currently matched. `type_keys` is
      // what src/ioc-export-by-type.njk paginates over to write each file at
      // /assets/data/ioc-index-<type>.csv; ordered the same as the type chips
      // above so the two lists agree.
      type_keys: Object.keys(byCountDesc(countsByType)),
      csv_by_type: toCsvByType(remoteWorkerRecords),
    },

    // What /repo-scanner/ searches, counts and lists for a reader without
    // JavaScript. One file, context quotes inline: at a few thousand records
    // it is small enough not to need the core/contexts split above.
    repo_scanner: {
      records: repoScannerRecords,
      total: repoScannerRecords.length,
      lastmod: latestDate(...repoScannerRecords.map((record) => record.lastmod)),
      counts_by_type: byCountDesc(repoCountsByType),
      counts_by_campaign: byCountDesc(repoCountsByCampaign),
      // Newest first, a curated entry ahead of a bulk-list one of the same
      // date, so the no-JS sample shows the richest records available.
      recent: [...repoScannerRecords]
        .sort(
          (a, b) =>
            compareText(b.last_seen || "", a.last_seen || "") ||
            Number(a.extraction.method === "bulk-dataset") -
              Number(b.extraction.method === "bulk-dataset") ||
            compareText(a.value, b.value)
        )
        .slice(0, FALLBACK_COUNT),
      compact: compactIndex(repoScannerRecords, generatedAt),
    },

    // The APT/espionage indicators, split out of /remote-workers/ but still
    // indexed, searchable on their cluster pages, and given their own pages.
    espionage: {
      records: espionageRecords,
      total: espionageRecords.length,
    },

    // What /etherhiding/ searches. `watchlist` is the raw curated file rather
    // than the indexed records, because the index deliberately drops
    // c2_pattern entries as non-identifiers and the tracker page should still
    // list the published detection rule alongside the addresses. Each entry
    // carries the id of its own indicator page where it has one.
    etherhiding: {
      records: etherhidingRecords,
      total: etherhidingRecords.length,
      lastmod: latestDate(...etherhidingRecords.map((record) => record.lastmod)),
      watchlist: (etherhiding || []).map((entry) => ({
        ...entry,
        indicator_id: NON_IDENTIFIER_TYPES.has(entry.ioc_type)
          ? null
          : recordId(entry.ioc_type, entry.value),
      })),
    },
  };
}

// Built once per set of data files, however many modules ask for it: see
// scripts/lib/memo.js.
module.exports = memoByDir(IOCS_DIR, buildIndex);
// For scripts/validate-data.js and the unit tests.
module.exports.FOLDED_TYPES = FOLDED_TYPES;
module.exports.mergeRecords = mergeRecords;
module.exports.foldDuplicateTypes = foldDuplicateTypes;
module.exports.toCsv = toCsv;
module.exports.searchCore = searchCore;
module.exports.typeLabel = typeLabel;
