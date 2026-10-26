/**
 * personas.js — the fabricated identities behind the reported LinkedIn accounts
 * ==========================================================================
 * Every LinkedIn account in the indicator index, grouped into the persona it
 * was reported under, so a reader can move from "an account exists" to "here
 * is everything one report attributed to the same fabricated identity".
 *
 * The grouping is not an inference this site makes. Reports that document
 * these operations organize their write-ups by persona, one heading per
 * identity, and the scraper already records which heading each indicator sat
 * under (`source.section`, see docs/scrape-dprk-iocs.md). Two indicators are
 * grouped here only when the same report filed them under the same heading;
 * nothing is merged across reports, and no persona is inferred from a shared
 * name, avatar or handle.
 *
 * Where that heading names a part of a report rather than an identity —
 * "Indicators of Compromise", "Email Addresses" — the account still gets an
 * entry and stands alone, with no siblings, because the source gave it none.
 * It can still carry a name: an account that is still up displays one, and
 * that display name is a fact about the account whatever the report called the
 * table it sat in. Each persona records which of the two its name came from in
 * `name_source`, so the pages can say so rather than implying a report made an
 * attribution it did not.
 *
 * Lives here rather than under src/_data/ because two data files need the same
 * grouping: src/_data/personas.js builds the pages, and src/_data/iocIndex.js
 * uses it to tag each indicator in the search index with the persona it was
 * reported under.
 */

const fs = require("fs");
const path = require("path");
const { compareText } = require("./compare.js");

/** Where a persona photograph must actually live to be rendered. */
const ASSETS_DIR = path.join(__dirname, "..", "..", "src", "assets");

/**
 * A pipu.cc listing's headshot. Those listings pair a harvested CV with a stock
 * portrait chosen to dress it, so the picture is a photograph of somebody who
 * has nothing to do with the account — very often the identity-theft victim
 * whose CV was taken.
 *
 * It stays on the persona's own page, where the entry explains what the listing
 * was and the CV sits beside it, and it is kept out of the listing, where a tile
 * is a face and a name and nothing else. A grid of portraits reads as a gallery
 * of operators; a stock photograph has no business being read that way, and no
 * caption reaches the reader at that size to say otherwise.
 */
const STOCK_HEADSHOT = /-pipu\.[a-z0-9]+$/i;

/**
 * A photograph is used only if the repository holds the file, the same rule
 * scripts/enrich-linkedin-accounts.js applies to a mirrored avatar. A dossier
 * naming an image that was never saved would render a broken box on a
 * published page, and the failure would be silent at build time.
 */
function photoOnDisk(photo) {
  if (!photo || !photo.src) return null;
  const file = path.join(ASSETS_DIR, photo.src.replace(/^\/assets\//, ""));
  return fs.existsSync(file) ? photo : null;
}

/** The subset of a persona's photographs the repository actually holds. */
function photosOnDisk(photos) {
  return (photos || []).map(photoOnDisk).filter(Boolean);
}

/**
 * Section headings that name a part of a report rather than a person. A
 * heading matching any of these is treated as structure: the account under it
 * gets an entry of its own with no name attached, rather than a name this
 * site invented for it.
 */
const STRUCTURAL_HEADING = /^(#|\d|ioc|indicator|email|github|linkedin|social|conclusion|appendix|about|analysis|finding|exposing|quick|anchor|known activity|investigation|repositor|link to|lure|stage|staging|compromise|profile engagement|direct engagement|key finding|account registration|validin|contagiousdrop|first actor|second actor|third actor|core team|it workers|actor[- ]controlled|related infrastructure|unattrib|misc|other|unknown)/i;

/**
 * Longest a heading segment may be and still read as a name. Personas are
 * routinely filed under several names at once — "Anthony Keller / Daiki
 * Saito", "Gary Lee / ChienHui Lee / Light Fury / Leech Developer" — so the
 * limit applies per segment, not to the heading as a whole. A heading whose
 * every segment runs longer than this is a sentence describing a finding
 * ("Third Actor and His Two Identities"), not somebody's name.
 */
const MAX_NAME_WORDS = 5;

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Split a heading into the names it lists, in the order the source lists them.
 * A slash and a spaced dash both separate names in these write-ups — the
 * heading 'Jikun Liao - "Justin Lim" / altbee' lists three.
 */
function splitNames(heading) {
  return heading
    .split(/\s+[-–—]\s+|\//)
    .map((part) => part.replace(/["“”]/g, "").trim())
    .filter(Boolean);
}

/**
 * The names a heading carries, or an empty list if it is structural. A
 * parenthetical is pulled out as a name of its own: reports write a handle
 * with the identity behind it in brackets — "promiseislaw (Marcin Iwanski)" —
 * and both halves are names the persona presented under.
 */
function namesFromHeading(heading) {
  const text = (heading || "").trim();
  if (!text || STRUCTURAL_HEADING.test(text)) return [];

  const names = [];
  for (const segment of splitNames(text)) {
    const bracketed = segment.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    const parts = bracketed ? [bracketed[2], bracketed[1]] : [segment];
    for (const part of parts) {
      const name = part.trim();
      if (name && wordCount(name) <= MAX_NAME_WORDS && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The source whose heading names the persona, falling back to the first cited. */
function anchorSource(record) {
  const sources = record.sources || [];
  return sources.find((source) => namesFromHeading(source.section).length) || sources[0] || null;
}

/**
 * One group per (report, heading) pair. An account under a structural heading
 * gets a group to itself keyed on the account, so it is never pooled with
 * unrelated indicators that happened to sit in the same appendix.
 */
function groupKey(record, source) {
  // A hand-transcribed dossier pins its own grouping: a researcher who
  // documents one operator across two posts is making one claim, not two, so
  // the key follows the persona rather than the URL it was published at.
  if (record.persona_key) return record.persona_key;
  if (!source) return `account ${record.id}`;
  if (!namesFromHeading(source.section).length) return `account ${record.id}`;
  return `section ${source.url || source.title} ${source.section}`;
}

function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Group a list of scraped indicator records into personas.
 *
 * @param {object[]} records - records in the shape scraped-iocs.json holds.
 * @returns {object[]} personas, named ones first and alphabetical within each.
 */
function buildPersonas(records) {
  // Pass one: every LinkedIn account opens a persona. Nothing else can — the
  // page is about the fabricated profiles, and a heading with no LinkedIn
  // account under it has no profile to show.
  const personas = new Map();
  for (const record of records) {
    // A LinkedIn account, or a dossier entry whose whole purpose is to assert
    // one. Any other scraped indicator joins a persona in pass two or not at
    // all — a heading with nothing to anchor it is not an identity.
    if (record.ioc_type !== "linkedin_profile" && !record.persona_anchor) continue;
    const source = anchorSource(record);
    const key = groupKey(record, source);
    if (!personas.has(key)) {
      // A dossier names its persona outright; only a scraped record's name has
      // to be recovered from the heading it was filed under.
      const names = record.persona_name
        ? [record.persona_name, ...(record.persona_aliases || [])]
        : namesFromHeading(source && source.section);
      personas.set(key, {
        key,
        // A dossier persona is a researcher's assertion about one operator; a
        // scraped one is a heading in a report. The pages word themselves
        // differently for each, so which it is has to travel with it.
        from_dossier: Boolean(record.persona_anchor),
        // A registry is a database with no byline or methodology, so a page
        // built from one must not say a named researcher made the attribution.
        from_registry: Boolean(record.extraction && record.extraction.method === "registry"),
        role: record.persona_role || null,
        heading: (source && source.section) || null,
        name: names[0] || null,
        name_source: names.length ? "heading" : null,
        aliases: names.slice(1),
        // Only a dossier carries these today; a scraped persona shows the
        // avatars of its individual LinkedIn accounts instead. `photo` is the
        // primary (kept for the card and the page's social image); `photos` is
        // every published image the entry carries, rendered in full on the page.
        photo: photoOnDisk(record.persona_photo),
        photos: photosOnDisk(record.persona_photos),
        // Every CV a cited page published under this identity, carried whole.
        // Only a dossier carries one; see resumeFor in scripts/lib/dossiers.js.
        resumes: [],
        // Files the cited page published under this identity; see attachmentsFor.
        attachments: [],
        accounts: [],
        identifiers: [],
        campaign: [],
        sources: [],
        // True once any record on this persona was read off a live account by
        // this site rather than stated by a source. The page cannot then tell
        // the reader that everything on it comes from the cited post, so the
        // wording branches on it. Set below, where the citations are gathered.
        observed_directly: false,
        // True once any record on this persona was transcribed from a
        // researcher's post or a registry, as opposed to read off a page by
        // this site. A persona with neither is documented by this site alone,
        // and its page has to say so rather than credit a researcher.
        reported_by_source: false,
        first_seen: null,
        last_seen: null,
      });
    }
    const persona = personas.get(key);
    // One persona can be documented by more than one dossier, and a later one
    // may state a name the first did not — the display name on a GitLab profile
    // found by searching the operator's handle, say. Those records share the
    // persona's key, so they never pass through the merge below that would
    // otherwise carry their aliases across, and without this the name reached
    // the index as an `alias` indicator while the persona's own list of names
    // went on omitting it.
    if (record.persona_name) {
      for (const name of [record.persona_name, ...(record.persona_aliases || [])]) {
        if (name && name !== persona.name && !persona.aliases.includes(name)) {
          persona.aliases.push(name);
        }
      }
    }
    // A persona is created from whichever of its records is seen first, and
    // that record may be the one without a photograph. Two researchers who
    // document the same identity group under one key, so the picture can
    // arrive on a later record than the one that opened the entry — which is
    // what happens to Jaron Gaston, opened by a post that published no image
    // and photographed by a second post entirely. Adopt the first photograph
    // offered rather than only the opening record's.
    if (!persona.photo) persona.photo = photoOnDisk(record.persona_photo);
    // Gather every published image across the persona's records, deduped by
    // path, so a persona photographed across more than one post or record
    // shows all of them and not just the first.
    for (const ph of photosOnDisk(record.persona_photos)) {
      if (!persona.photos.some((existing) => existing.src === ph.src)) persona.photos.push(ph);
    }
    if (!persona.photo) persona.photo = persona.photos.find((ph) => ph.face) || null;
    if (record.persona_resume && !persona.resumes.some((cv) => cv.url === record.persona_resume.url)) {
      persona.resumes.push(record.persona_resume);
    }
    for (const a of record.persona_attachments || []) {
      if (!persona.attachments.some((x) => x.src === a.src)) persona.attachments.push(a);
    }
    // Only a LinkedIn account goes in the accounts list; a dossier's other
    // indicators are gathered below with everything else reported alongside.
    if (record.ioc_type === "linkedin_profile") {
      // Deduped by URL: one report may cite the same account twice, and a
      // persona listing it twice would double-count live_accounts.
      if (!persona.accounts.some((account) => account.url === record.value)) {
        persona.accounts.push({
          url: record.value,
          handle: record.display || record.value,
          status: record.account_status || null,
        });
      }
    } else if (
      // Two dossiers documenting one persona routinely list the same address
      // or handle; the page should show it once, with every citation under it.
      !persona.identifiers.some((held) => held.ioc_type === record.ioc_type && held.value === record.value)
    ) {
      persona.identifiers.push({
        id: record.id,
        ioc_type: record.ioc_type,
        value: record.value,
        display: record.display || null,
        status: record.account_status || null,
      });
    }
    persona.first_seen = earliest(persona.first_seen, record.first_seen);
    persona.last_seen = latest(persona.last_seen, record.last_seen);
    for (const campaign of record.campaign || []) {
      if (!persona.campaign.includes(campaign)) persona.campaign.push(campaign);
    }
  }

  // An account under a structural heading has no name from the reporting, but
  // if it is still up it displays one of its own. Using it beats listing the
  // account by its URL slug, and it is the name the operation actually
  // presented under — which is what this page is a list of.
  for (const persona of personas.values()) {
    if (persona.name) continue;
    const displayed = persona.accounts
      .map((account) => account.status && account.status.profile && account.status.profile.name)
      .find(Boolean);
    if (displayed) {
      persona.name = displayed;
      persona.name_source = "profile";
    }
  }

  // Pass two: everything else the same report filed under the same heading.
  const bySection = new Map();
  for (const persona of personas.values()) {
    if (persona.key.startsWith("section ")) bySection.set(persona.key, persona);
  }
  for (const record of records) {
    if (record.ioc_type === "linkedin_profile" || record.persona_anchor) continue;
    for (const source of record.sources || []) {
      const persona = bySection.get(groupKey(record, source));
      if (!persona) continue;
      persona.identifiers.push({
        id: record.id,
        ioc_type: record.ioc_type,
        value: record.value,
        display: record.display || null,
        status: record.account_status || null,
      });
      persona.first_seen = earliest(persona.first_seen, record.first_seen);
      persona.last_seen = latest(persona.last_seen, record.last_seen);
    }
  }

  for (const persona of personas.values()) {
    // Citations, collected once per persona from every record that belongs to
    // it, so the page cites the reports rather than repeating one list of
    // sources under each individual identifier.
    const members = new Set([
      ...persona.accounts.map((account) => account.url),
      ...persona.identifiers.map((identifier) => identifier.value),
    ]);
    const seen = new Set();
    for (const record of records) {
      if (!members.has(record.value)) continue;
      // A value two personas share arrives here once per dossier that lists
      // it, and each copy carries its own dossier's key. A directly observed
      // value counts wherever it was observed, since it is on this page either
      // way; but only this persona's own dossiers can make its page credit a
      // researcher with naming it. A registry's record of an address this site
      // read off a live account says the registry claims the address, not that
      // a researcher attributed this persona.
      const ownDossier = !record.persona_key || record.persona_key === persona.key;
      if (record.extraction && record.extraction.method === "curated") {
        persona.observed_directly = true;
      } else if (record.extraction && record.extraction.method !== "regex") {
        if (ownDossier) persona.reported_by_source = true;
      }
      for (const source of record.sources || []) {
        const url = source.url || source.title;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        persona.sources.push({
          url: source.url || null,
          title: source.title || source.url,
          publisher: source.publisher || null,
          published: source.published || null,
          section: source.section || null,
          pulled_at: source.pulled_at || null,
        });
      }
    }

  }

  // Two personas that carry the same name AND share an indicator are one
  // operator described twice. This is the only place anything merges across
  // sources, and it merges on evidence rather than on a coincidence of naming:
  // ZachXBT and tayvano both document "Gary Lee", and both list
  // leech.developer@gmail.com and github.com/light-fury under him. A shared
  // name alone is never enough - "Ri Min Hyok" and "Jon Son Chol" are common
  // Korean names, and two unrelated operators could share one.
  // The form a value takes when the merge compares it. Values are otherwise
  // compared exactly, and that is deliberate: this is the one place the site
  // joins two reports, and it joins on evidence rather than on resemblance.
  //
  // The single rewrite is not a loosening of that. A GitHub Pages user site at
  // <user>.github.io is served only from the account named <user>, so a profile
  // publishing that hostname and a report listing that account are naming one
  // account in two URL shapes — which is what lets the Medium profile
  // @smartdev0205, whose about page gives its website as brent-jeremy.github.io,
  // join the persona the report filed github.com/brent-jeremy under. The two
  // indicator records stay separate, because a site and an account are
  // different things to go and look at; only the question of whether two
  // personas are one operator treats them as the same fact.
  //
  // Only a bare user site rewrites. A path below it addresses one of the
  // account's repositories rather than the account, and holding the rule to the
  // root holds it to the case where the hostname IS the identifier.
  const mergeValue = (value) => {
    const pages = String(value)
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .match(/^([a-z0-9][a-z0-9-]*)\.github\.io$/i);
    return pages ? `https://github.com/${pages[1].toLowerCase()}` : value;
  };

  const valuesOf = (persona) =>
    new Set([
      ...persona.accounts.map((account) => mergeValue(account.url)),
      ...persona.identifiers.map((identifier) => mergeValue(identifier.value)),
    ]);

  function absorb(target, other) {
    for (const alias of other.aliases) {
      if (alias !== target.name && !target.aliases.includes(alias)) target.aliases.push(alias);
    }
    const seenAccounts = new Set(target.accounts.map((account) => account.url));
    for (const account of other.accounts) {
      if (!seenAccounts.has(account.url)) target.accounts.push(account);
    }
    const seenValues = new Set(target.identifiers.map((identifier) => identifier.value));
    for (const identifier of other.identifiers) {
      if (!seenValues.has(identifier.value)) target.identifiers.push(identifier);
    }
    for (const campaign of other.campaign) {
      if (!target.campaign.includes(campaign)) target.campaign.push(campaign);
    }
    const seenSources = new Set(target.sources.map((source) => source.url));
    for (const source of other.sources) {
      if (!seenSources.has(source.url)) target.sources.push(source);
    }
    target.first_seen = earliest(target.first_seen, other.first_seen);
    target.last_seen = latest(target.last_seen, other.last_seen);
    if (!target.photo && other.photo) target.photo = other.photo;
    for (const ph of other.photos || []) {
      if (!(target.photos || []).some((existing) => existing.src === ph.src)) {
        (target.photos = target.photos || []).push(ph);
      }
    }
    if (!target.photo && target.photos && target.photos.length)
      target.photo = target.photos.find((ph) => ph.face) || null;
    // The page wording branches on this, and a persona corroborated by both a
    // report and a researcher post should read as the report, with the post as
    // a further citation.
    target.from_dossier = target.from_dossier && other.from_dossier;
    target.from_registry = Boolean(target.from_registry || other.from_registry);
    target.role = target.role || other.role || null;
    // Unlike from_dossier, this is a union: one directly observed value
    // anywhere on the merged page is enough to make the "everything below is
    // from the post" wording wrong.
    target.observed_directly = target.observed_directly || other.observed_directly;
    target.reported_by_source = target.reported_by_source || other.reported_by_source;
    for (const a of other.attachments || []) {
      if (!(target.attachments = target.attachments || []).some((x) => x.src === a.src)) target.attachments.push(a);
    }
    for (const cv of other.resumes || []) {
      if (!target.resumes.some((existing) => existing.url === cv.url)) target.resumes.push(cv);
    }
    target.corroborated = true;
  }

  const byName = new Map();
  const merged = [];
  for (const persona of personas.values()) {
    if (!persona.name) {
      merged.push(persona);
      continue;
    }
    const key = persona.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(persona);
  }

  // Merging runs to a fixpoint within each name, not in a single pass. Three
  // reports where the third names accounts from the first two describe one
  // operator, and one pass would leave the first two apart because neither
  // shared a value with the other until the third arrived to bridge them.
  for (const group of byName.values()) {
    const clusters = [...group];
    let joined = true;
    while (joined) {
      joined = false;
      search: for (let a = 0; a < clusters.length; a += 1) {
        for (let b = a + 1; b < clusters.length; b += 1) {
          const other = valuesOf(clusters[b]);
          if (![...valuesOf(clusters[a])].some((value) => other.has(value))) continue;
          absorb(clusters[a], clusters[b]);
          clusters.splice(b, 1);
          joined = true;
          break search;
        }
      }
    }
    merged.push(...clusters);
  }

  // A persona is an identity, so it has to carry one: a name, or a face
  // published as the face of one. An entry with neither is not a persona but a
  // bare account — thirteen LinkedIn URLs listed in an appendix or an indicator
  // table rather than under an identity heading, every one of them since
  // removed, so there is no displayed name left to recover either. Dropping
  // them costs nothing: a value with no persona keeps its own /indicators/
  // page, which is where it belongs. Carrying them filled the grid with blank
  // tiles that named nobody.
  //
  // A stock portrait is not a face for this test either: a pipu entry has to
  // earn its place on its name and the indicators beside it, never on the
  // picture the listing dressed the CV with. Every one now published has a name
  // and at least two indicators.
  const identities = merged.filter(
    (persona) =>
      Boolean(persona.name) ||
      (persona.photos || []).some((photo) => !STOCK_HEADSHOT.test(photo.src || ""))
  );
  // Derived fields are computed HERE, after merging, not before it. Computing
  // them earlier left a merged persona reporting live_accounts: 0 and no avatar
  // while holding a live account with a photo - the merge appends to accounts[]
  // and cannot know to recompute a field that has already run.
  for (const persona of identities) {
    // A locale explicitly pinned rather than left to the runtime default: this
    // ordering is baked into the built site, and an unpinned localeCompare
    // resolves its collation from the environment (LANG/LC_ALL, or the OS
    // locale API on Windows), which the author's machine and the Ubuntu
    // deploy runner are not guaranteed to agree on.
    persona.accounts.sort((a, b) => compareText(a.handle, b.handle));
    persona.identifiers.sort(
      (a, b) => compareText(a.ioc_type, b.ioc_type) || compareText(a.value, b.value)
    );
    persona.live_accounts = persona.accounts.filter(
      (account) => account.status && account.status.state === "live"
    ).length;
    // The thumbnail the listing renders and sorts on. Two things can supply
    // one, and they are different kinds of picture: a LinkedIn account's own
    // avatar, which is what the account presents itself as, or a photograph a
    // researcher or registry published of whoever appeared under the identity.
    // The account's own comes first where both exist, because it is a fact
    // about the account rather than somebody's claim about a person — but a
    // dossier persona usually has no LinkedIn account at all, and before the
    // fallback existed every one of them showed a blank tile. Only a face
    // qualifies: a tile in the grid is a picture and a name with no caption,
    // so a screenshot of a table or a directory listing, marked face: false
    // on the dossier, renders on the persona's own page and nowhere else.
    const ownPhoto = (persona.photos || []).find(
      (photo) => photo.src && photo.face !== false && !STOCK_HEADSHOT.test(photo.src)
    );
    persona.avatar =
      persona.accounts
        .map((account) => account.status && account.status.avatar)
        .find(Boolean) ||
      (ownPhoto && ownPhoto.src) ||
      null;
  }

  // Named personas first, then the accounts no report gave a name to. Within
  // each, the ones with a picture lead: a scattering of faces through a grid of
  // otherwise blank tiles reads as broken. This mattered more when five tiles
  // out of thirty-eight carried one; with the mirrored registry photographs it
  // is now most of them, and the sort mainly keeps the empty ones together at
  // the end. Alphabetical breaks the remaining ties.
  //
  // Slugs are assigned after the sort so the suffix a collision earns is
  // stable against a re-scrape rather than dependent on record order.
  // A dossier persona may hold no LinkedIn account at all, so every fallback
  // to the first account has to tolerate an empty list.
  const label = (p) => p.name || (p.accounts[0] && p.accounts[0].handle) || p.slug || "persona";
  const ordered = identities.sort((a, b) => {
    if (Boolean(a.name) !== Boolean(b.name)) return a.name ? -1 : 1;
    if (Boolean(a.avatar) !== Boolean(b.avatar)) return a.avatar ? -1 : 1;
    // Locale pinned for the same reason as the sorts above: this order decides
    // slug collision suffixes, which have to be stable across environments.
    return compareText(label(a), label(b));
  });

  const usedSlugs = new Set();
  for (const persona of ordered) {
    const base = slugify(label(persona)) || "persona";
    let slug = base;
    let suffix = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${suffix++}`;
    usedSlugs.add(slug);
    persona.slug = slug;
    delete persona.key;
  }

  return ordered;
}

/**
 * Indicator value -> the named persona it was reported under, for tagging the
 * search index. Only named personas are listed: an account the source filed
 * under a structural heading has no identity to tag it with.
 *
 * A value appearing under two personas keeps the first, which is the
 * alphabetically-earlier named one — the tag says "reported under this
 * identity", and asserting two identities for one address from that alone
 * would be a claim no source made.
 */
function personaByValue(personas) {
  const byValue = new Map();
  for (const persona of personas) {
    if (!persona.name) continue;
    const tag = { name: persona.name, slug: persona.slug };
    const values = [
      ...persona.accounts.map((account) => account.url),
      ...persona.identifiers.map((identifier) => identifier.value),
    ];
    for (const value of values) {
      if (!byValue.has(value)) byValue.set(value, tag);
    }
  }
  return byValue;
}

/**
 * Indicator value -> every persona whose page lists it, named or not.
 *
 * personaByValue above answers a different question — "which identity does a
 * search result belong to", one tag, deliberately the first — and is wrong for
 * routing, because the page a reader should land on has to be a page that
 * actually carries the indicator. All of them do.
 *
 * A value with exactly one entry here has a home: src/_data/iocIndex.js turns it
 * into the persona-page anchor every link to that indicator points at, and
 * /indicators/{id}/ becomes a redirect to it. A value with two or more has no
 * single home — 188.43.253.77 is listed under both James McClung and Ondriah
 * Young — so it keeps its own page, which is where the personas sharing it are
 * listed. That page is the join between them and cannot be folded into either.
 */
function personasByValue(personas) {
  const byValue = new Map();
  for (const persona of personas) {
    const entry = { name: persona.name, slug: persona.slug };
    const values = [
      ...persona.accounts.map((account) => account.url),
      ...persona.identifiers.map((identifier) => identifier.value),
    ];
    for (const value of values) {
      if (!byValue.has(value)) byValue.set(value, []);
      const list = byValue.get(value);
      if (!list.some((held) => held.slug === entry.slug)) list.push(entry);
    }
  }
  return byValue;
}

module.exports = { buildPersonas, personaByValue, personasByValue, namesFromHeading };
