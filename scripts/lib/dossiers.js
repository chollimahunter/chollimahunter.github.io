/**
 * dossiers.js — persona dossiers transcribed from researcher posts
 * ==========================================================================
 * Converts src/_data/iocs/x-dossiers.json into records in the same shape the
 * scraper writes, so the identifier index and the persona pages consume them
 * through the paths they already have rather than growing a second one.
 *
 * WHY THESE ARE HAND-TRANSCRIBED RATHER THAN SCRAPED
 * --------------------------------------------------
 * x.com serves a JavaScript shell to an anonymous request and renders through
 * an authenticated API, so scrape-dprk-iocs.js cannot reach it from CI — the
 * same wall that keeps LinkedIn liveness checking in a separate manual script.
 * The posts also write indicators in forms the shared extractors deliberately
 * reject: defanged (`name@gmail[.]com`), domainless (`gmail = marksantiago0929`),
 * and as bare handles. Loosening those regexes to catch this one source would
 * raise the false-positive rate across all 29 scraped sources, which is a bad
 * trade. A person transcribes instead, and the file records exactly what was
 * transcribed and from which post.
 *
 * WHAT A DOSSIER ASSERTS, AND WHAT THIS SITE ASSERTS
 * --------------------------------------------------
 * Entries name their researcher by key into the file's `researchers` map, so
 * one file can hold work from several people and every record cites the person
 * who published it.
 *
 * The researcher's assertion is that a set of accounts belongs to one operator,
 * and in many entries that the operator's real name is a specific Korean name.
 * That is a stronger claim than any other source in this corpus makes, and it
 * carries no methodology section a reader can check — which is why these
 * records take their own provenance label rather than borrowing one from the
 * scraper. Indicators the post left unattributed stay unattributed here.
 *
 * One exception, by design. If the scraper independently matches the same value
 * in a published report, mergeRecords in src/_data/iocIndex.js promotes the
 * record's label from `researcher-post` to `regex` — a value a machine found
 * verbatim in a vendor report is better evidenced than the same value in a
 * post, so the stronger label wins. Nothing is lost: the record keeps both
 * citations, and the persona page still credits the researcher. Two records
 * are in that state today, both from the Gary Lee dossier.
 */

const {
  recordId,
  normalizeEmail,
  normalizeGithub,
  normalizeLinkedin,
  PLATFORM_ACCOUNTS,
  normalizePlatformAccount,
  normalizeWallet,
  normalizeEns,
  normalizeSkype,
  normalizeHostedSite,
  normalizePayloadUrl,
  normalizeDomain,
  normalizeNpmPackage,
  normalizeAlias,
  normalizeIpv4,
  normalizePhone,
  safeDecode,
} = require("./ioc-normalize.js");

const fs = require("fs");
const path = require("path");
const { readJsonIfPresent } = require("./read-json.js");

/**
 * LinkedIn liveness, read from the same observations file
 * scripts/enrich-linkedin-accounts.js applies to the scraped dataset.
 *
 * It has to be attached here rather than written into x-dossiers.json, because
 * that file records what a post STATES and an account being up or gone today
 * is not that — it is an observation with its own date, and it changes without
 * the post changing. The observations file stays the reviewable artefact
 * either way, so the two paths agree on both the source and the shape.
 *
 * A missing file is not an error: liveness is enrichment, and the dossier
 * pages render perfectly well without it.
 */
const LINKEDIN_STATUS_PATH = path.join(__dirname, "..", "data", "linkedin-account-status.json");
const LINKEDIN_PHOTO_DIR = path.join(__dirname, "..", "..", "src", "assets", "img", "linkedin");

const linkedinStatus = (() => {
  const bySlug = new Map();
  const doc = readJsonIfPresent(LINKEDIN_STATUS_PATH, {});
  for (const account of doc.accounts || []) bySlug.set(account.slug.toLowerCase(), account);
  return { bySlug, checked: doc.checked || null };
})();

function linkedinAccountStatus(value) {
  const slug = safeDecode(String(value).split("/").filter(Boolean).pop()).toLowerCase();
  const observed = linkedinStatus.bySlug.get(slug);
  if (!observed) return null;
  // Only claim a photo the repository actually holds, the same rule
  // scripts/enrich-linkedin-accounts.js applies: a status file naming a file
  // that was never mirrored would render a broken image on a published page.
  const file = `${observed.slug}.jpg`;
  const mirrored =
    observed.state === "live" && fs.existsSync(path.join(LINKEDIN_PHOTO_DIR, file));
  const status = {
    state: observed.state,
    // Per-account date first, for an account checked between full sweeps. See
    // the same rule in scripts/enrich-linkedin-accounts.js.
    checked: observed.checked || linkedinStatus.checked,
    avatar: mirrored ? `/assets/img/linkedin/${file}` : null,
  };
  // A profile block describes a live account. One attached to a removed
  // account cannot be re-read against its own source, so it is dropped —
  // the same rule the enrichment script applies.
  if (observed.state === "live" && observed.profile) status.profile = observed.profile;
  return status;
}

/**
 * GitHub liveness, on the same footing as the LinkedIn block above and for the
 * same reason: scripts/enrich-github-accounts.js only ever reads
 * scraped-iocs.json, so an account that reaches this site by hand had no
 * status at all — 125 of them, none checked, until this file existed.
 *
 * `account_id` is what makes the file worth having. GitHub frees a deleted
 * account's login for anyone to re-register, and a status of live/removed
 * cannot see that: a recycled handle answers 200 and reads as live, and the
 * page would present whoever holds it now as the account a researcher named.
 * One of these 125 was in exactly that state.
 *
 * An avatar is claimed only where the enrichment already mirrored one and the
 * file is still on disk — the same rule the LinkedIn path applies, and for the
 * same reason: naming a file the repository does not hold renders a broken
 * image. A recycled entry never carries one, because the picture would be of
 * whoever holds the login now.
 */
const { platformAccountStatus } = require("./platform-status.js");
const GITHUB_STATUS_PATH = path.join(__dirname, "..", "data", "github-account-status.json");
const GITHUB_AVATAR_DIR = path.join(__dirname, "..", "..", "src", "assets", "img", "github");

const githubStatus = (() => {
  const byLogin = new Map();
  const doc = readJsonIfPresent(GITHUB_STATUS_PATH, {});
  for (const account of doc.accounts || []) byLogin.set(account.login.toLowerCase(), account);
  return { byLogin, checked: doc.checked || null };
})();

function githubAccountStatus(value) {
  const login = safeDecode(String(value).split("/").filter(Boolean).pop()).toLowerCase();
  const observed = githubStatus.byLogin.get(login);
  if (!observed) return null;
  const mirrored =
    observed.state !== "recycled" &&
    observed.avatar &&
    fs.existsSync(path.join(GITHUB_AVATAR_DIR, path.basename(observed.avatar)));
  const status = {
    state: observed.state,
    checked: observed.checked || githubStatus.checked,
    avatar: mirrored ? observed.avatar : null,
  };
  if (observed.account_id) status.account_id = observed.account_id;
  // Only a recycled entry carries these, and the page needs both to state the
  // gap between when the identifier was published and when the account now
  // answering to the name was created.
  if (observed.state === "recycled") {
    status.account_created = observed.account_created || null;
    status.reported = observed.reported || null;
  }
  return status;
}

/**
 * What a telephone number actually is, where it has been looked up.
 *
 * A number on its own says very little: it is ten digits a CV printed, and the
 * area code is whatever the operator picked. The line type is the fact worth
 * having. A DPRK IT-worker persona claiming a Texas address and reachable on a
 * VoIP line bought through a web service is a different proposition from one
 * reachable on a carrier mobile, and where a reverse lookup returns a name at
 * all, that name is either the operator's cover or — far more often in this
 * dataset — a real person whose identity the CV is built on.
 *
 * The lookups cannot run from CI. phonevalidator.com and spydialer.com both
 * answer a human in a browser and neither publishes an API, which is the same
 * wall LinkedIn liveness sits behind, so this follows the same split: a person
 * does the lookups, the observations land in scripts/data/phone-lookups.json,
 * and the build does nothing but read them. See docs/phone-line-types.md.
 *
 * Nothing is inferred from a missing entry. A number with no lookup renders with
 * no line-type block at all rather than as "unknown", because the two are
 * different claims.
 */
const PHONE_LOOKUP_PATH = path.join(__dirname, "..", "data", "phone-lookups.json");

const phoneLookups = (() => {
  const byValue = new Map();
  const doc = readJsonIfPresent(PHONE_LOOKUP_PATH, {});
  for (const entry of doc.numbers || []) byValue.set(entry.value, entry);
  return { byValue, checked: doc.checked || null };
})();

function phoneLineStatus(value) {
  const observed = phoneLookups.byValue.get(value);
  if (!observed) return null;
  return {
    line_type: observed.line_type || null,
    carrier: observed.carrier || null,
    // The carrier the thousand-block is assigned to, where that is a different
    // company from the one answering for the number itself. Skype resells
    // Bandwidth's numbers, so 832-706-3757 is Skype's line inside Bandwidth's
    // block, and saying only one of those loses something.
    block_carrier: observed.block_carrier || null,
    // "number" where a per-number lookup answered for this line, "block" where
    // the only evidence is which carrier the NPA-NXX block is assigned to. A
    // ported number can sit in another carrier's block, which is exactly why
    // the two are not presented as the same claim.
    basis: observed.basis || null,
    location: observed.location || null,
    // Names a reverse lookup returned against the number. Carried as a list
    // because these services return several, and labelled on the page as what
    // they are: somebody a directory associates with the line, not an
    // attribution this site makes.
    names: observed.names || [],
    prepaid: observed.prepaid || null,
    checked: observed.checked || phoneLookups.checked,
    looked_up_at: observed.sources || [],
    note: observed.note || null,
  };
}

/**
 * The same normalizers the scraper uses, so a value transcribed here and the
 * same value matched in a report later collapse to one record instead of two
 * that differ only by scheme or letter case.
 *
 * A normalizer returning null means the transcription is malformed, which is a
 * data error rather than something to publish — so it throws, loudly, at build
 * time. There is no runtime path where a bad value should reach a page.
 */
const NORMALIZERS = {
  email_address: normalizeEmail,
  github_profile: normalizeGithub,
  linkedin_profile: normalizeLinkedin,
  wallet_address: normalizeWallet,
  ens_name: normalizeEns,
  skype_account: normalizeSkype,
  hosted_site: normalizeHostedSite,
  payload_url: normalizePayloadUrl,
  domain: normalizeDomain,
  // Curated, so a version pin is kept: see the note above normalizeNpmPackage
  // and the bulk-dataset rule in CONTENT_GUIDE.md.
  npm_package: (value) => normalizeNpmPackage(value, { keepVersion: true }),
  alias: normalizeAlias,
  ip_address: normalizeIpv4,
  phone_number: normalizePhone,
  ...Object.fromEntries(
    PLATFORM_ACCOUNTS.map((spec) => [spec.ioc_type, normalizePlatformAccount(spec)])
  ),
};

function normalizeValue(indicator, personaLabel) {
  const normalize = NORMALIZERS[indicator.ioc_type];
  if (!normalize) return indicator.value;
  const value = normalize(indicator.value);
  if (!value) {
    throw new Error(
      `x-dossiers.json: ${personaLabel} — ${indicator.ioc_type} "${indicator.value}" ` +
        "did not normalize. Fix the transcription."
    );
  }
  return value;
}

/**
 * The provenance label these records carry. Distinct from "curated" (a
 * maintainer's own judgment about a value) and from "regex" (a machine matched
 * it literally in a published report): this is a named researcher's assertion,
 * transcribed faithfully, and the reader should weigh it as that.
 */
const EXTRACTION = { method: "researcher-post", model: null, grounded: true };

/**
 * A file may declare its own provenance label in `defaults.method`.
 *
 * The schema fits two different kinds of source. An X post is one named
 * researcher's public claim, made once, on a date. A third-party registry is a
 * standing database with no byline and no methodology page. Both are "somebody
 * else asserts this", but a reader weighs them differently, so they carry
 * different labels rather than being flattened into one.
 */
function extractionFor(config) {
  const method = config.defaults && config.defaults.method;
  return method ? { method, model: null, grounded: true } : { ...EXTRACTION };
}

function postsFor(entry) {
  return entry.posts && entry.posts.length ? entry.posts : [];
}

/**
 * The image the cited post published of the persona, where it published one.
 *
 * Some of these posts carry a photograph of whoever appeared under the
 * identity — a still from an interview call, a profile capture — and it is the
 * one part of a dossier a reader cannot reconstruct from a list of accounts.
 * It is resolved here rather than in the template so the citation travels with
 * it: the post it came from, and the researcher who published it, are what
 * make it evidence rather than a picture of somebody.
 *
 * `file` names a path under src/assets/img/personas/. It is checked against the
 * repository at build time by scripts/lib/personas.js, on the same rule the
 * LinkedIn enrichment follows — never claim a photo the repository does not
 * hold, because the alternative is a broken image on a published page.
 */
function photoFor(entry, posts, publisher) {
  // The representative portrait, used for the persona card and the page's social
  // image. It must be an actual face: a GitHub or LinkedIn profile screenshot
  // whose avatar is an identicon, a default silhouette or a cartoon is evidence,
  // not a likeness, and belongs beside the indicator rather than in the grid of
  // faces. `face: false` on a photo marks exactly that; the first real face wins.
  return photosFor(entry, posts, publisher).find((photo) => photo.face) || null;
}

/**
 * Every photograph an entry carries. An entry may name one image in `photo` or
 * several in `photos[]`; both take the same { file, post, caption } shape and
 * both are returned here in order, so a persona documented by more than one
 * published picture -- the two portraits and the delegation shot of a named
 * official, say -- shows all of them rather than only the first.
 */
function photosFor(entry, posts, publisher) {
  const raw = [];
  if (entry.photo && entry.photo.file) raw.push(entry.photo);
  for (const ph of entry.photos || []) if (ph && ph.file) raw.push(ph);
  return raw.map((ph) => {
    const post = posts[ph.post || 0] || posts[0] || {};
    return {
      src: ph.file,
      caption: ph.caption || "",
      // Whether the image is a real face (eligible for the persona grid) or a
      // profile/chart/document screenshot kept as indicator evidence. Defaults
      // to a face when unmarked so pre-existing portraits keep showing.
      face: ph.face !== false,
      url: post.url || null,
      published: post.date || null,
      publisher,
    };
  });
}

/**
 * A curriculum vitae the cited page published under this identity, carried
 * whole. A marketplace listing that hides a CV in its product description is
 * the one source in this corpus that states, in the operator's own words, the
 * employer history and skills a persona is built to claim, and a summary of it
 * would put the summary beyond the record. `text` is the description as read,
 * with only the markdown emphasis stripped; the header fields are the same
 * lines a reader would take from its top. The post it came from travels with
 * it, so the block cites the page and the date it was read.
 */
function resumeFor(entry, posts, publisher) {
  const cv = entry.resume;
  if (!cv || !cv.text) return null;
  const post = posts[cv.post || 0] || posts[0] || {};
  return {
    name: cv.name || entry.persona || null,
    headline: cv.headline || null,
    location: cv.location || null,
    text: cv.text,
    url: post.url || null,
    published: post.date || null,
    read: cv.read || null,
    publisher,
  };
}

/**
 * Files the cited page published under this identity and this repository
 * mirrors (a CV as a PDF, say), each { file, title, description, bytes, post }.
 * A file missing from disk is dropped rather than linked broken.
 */
function attachmentsFor(entry, posts, publisher) {
  return (entry.attachments || [])
    .filter((a) => a && a.file && fs.existsSync(path.join(__dirname, "..", "..", "src", a.file)))
    .map((a) => {
      const post = posts[a.post || 0] || posts[0] || {};
      return {
        src: a.file,
        title: a.title || path.basename(a.file),
        description: a.description || "",
        bytes: a.bytes || null,
        url: post.url || null,
        publisher,
      };
    });
}

/**
 * The lines of the cited page around the indicator, as the page prints them.
 *
 * The scraper gives every record it extracts a `context` quote — the text either
 * side of the value in the report — and that quote is most of what makes a record
 * judgeable: it is the difference between "this address is in the index" and
 * "this address is the contact line of a CV claiming eleven years at Stripe". A
 * dossier had no equivalent. Its context was the transcriber's note, which
 * describes the entry as a whole and says nothing about where in the page any one
 * value sat, and for the CVs read off pipu.cc that left the page showing a
 * telephone number with no sign that it came from a résumé header at all.
 *
 * So where the entry carries the page's own text, the lines around the value are
 * quoted from it. Line structure is kept rather than collapsed to a sentence: in
 * a CV the neighbouring lines are the other contact details, and the block
 * reading "Email: … / Phone: … / Location: …" is itself the finding.
 *
 * The value is looked for as the entry writes it and, failing that, digit by
 * digit with any punctuation between — a telephone number is stored in E.164 and
 * the page it came from prints it as "(832) 706-3757", so a literal search for
 * the stored value would never match the document it was read from.
 */
function excerptAround(text, ...candidates) {
  if (!text) return "";
  for (const candidate of candidates) {
    const needle = String(candidate || "");
    if (needle.length < 4) continue;
    let at = text.toLowerCase().indexOf(needle.toLowerCase());
    if (at === -1 && /^\+?[\d\s().+-]{7,}$/.test(needle)) {
      // Drop a NANP country code before matching: a US CV prints the number
      // without it far more often than with it.
      const digits = needle.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      const loose = new RegExp(digits.split("").join("[\\s().+-]*"));
      const found = text.match(loose);
      if (found) at = found.index;
    }
    if (at === -1) continue;
    return linesAround(text, at);
  }
  return "";
}

const EXCERPT_LINES_EITHER_SIDE = 2;
const EXCERPT_MAX = 700;

function linesAround(text, at, either = EXCERPT_LINES_EITHER_SIDE) {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  let hit = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const end = offset + lines[i].length;
    if (at >= offset && at <= end) {
      hit = i;
      break;
    }
    offset = end + 1;
  }
  const from = Math.max(0, hit - either);
  const to = Math.min(lines.length, hit + either + 1);
  const snippet = lines
    .slice(from, to)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, EXCERPT_MAX);
  if (!snippet) return "";
  return `${from > 0 ? "…\n" : ""}${snippet}${to < lines.length ? "\n…" : ""}`;
}

/**
 * One record per indicator. `sources[].section` carries the persona name, which
 * is the same slot the scraper fills with the heading an indicator sat under —
 * so scripts/lib/personas.js groups these with no special case. `persona_key`
 * pins that grouping to the persona rather than to the post URL, because a
 * researcher who documents one operator across two posts is making one claim,
 * not two.
 */
/**
 * The persona's own name, and every alias beside it, as `alias` indicators.
 *
 * These are derived rather than transcribed, because the entry already states
 * them: `persona` and `aliases[]` are exactly the names the source gave, and
 * writing each one out again in `indicators[]` would be the same fact recorded
 * twice and a standing chance of the two drifting apart. Deriving them also
 * makes the rule uniform across every entry in all three files at once, which
 * hand-editing would not.
 *
 * It matters because of what the index is for. Jason Rostro's page was reachable
 * by his address and his telephone number and not by his name, even though the
 * name is the thing a recruiter actually has in front of them, and the same was
 * true of every persona the file has ever carried. The name was on the page and
 * not in the index.
 *
 * An alias that is not shaped like a name is skipped rather than thrown on.
 * `aliases[]` legitimately holds handles -- `mymiracle0118`, `kstar0102` -- and
 * a handle is somebody's account name, not a person's name; those are already
 * carried by whichever account type fits them. That is the opposite of the rule
 * for a transcribed indicator, where a value that will not normalize is a
 * transcription error and has to stop the build.
 */
function derivedAliases(entry) {
  const already = new Set(
    (entry.indicators || [])
      .filter((i) => i.ioc_type === "alias")
      .map((i) => String(i.value).toLowerCase())
  );
  // An alias that is already the handle inside one of this entry's own
  // accounts is that account's name, not a second indicator. `trustmeforever`
  // and `iwakihiroto` are listed as aliases and are also the GitHub and
  // Telegram handles two lines below, and minting an `alias` record for each
  // would put the same string in the index twice under two different claims.
  const inAccounts = new Set(
    (entry.indicators || [])
      .filter((i) => i.ioc_type !== "alias")
      .flatMap((i) => String(i.value).toLowerCase().split(/[/:@]+/))
      .filter(Boolean)
  );
  const out = [];
  for (const name of [entry.persona, ...(entry.aliases || [])]) {
    if (!name) continue;
    const value = normalizeAlias(name);
    if (!value) continue;
    const key = value.toLowerCase();
    if (already.has(key) || inAccounts.has(key)) continue;
    already.add(key);
    out.push({ ioc_type: "alias", value, post: 0 });
  }
  return out;
}

function recordsFor(entry, config, sectionLabel, personaKey, persona) {
  const posts = postsFor(entry);
  const researcher = config.researchers[entry.researcher];
  if (!researcher) {
    throw new Error(
      `x-dossiers.json: ${sectionLabel} names researcher "${entry.researcher}", ` +
        "which is not in the researchers map."
    );
  }
  const publisher = researcher.publisher;
  // An entry may name its own cluster, falling back to the file-wide default.
  // Most of this file is IT-worker fraud, which is why that is the default, but
  // the same researchers also post lure campaigns -- a fake recruiter running a
  // malicious take-home test is Contagious Interview, and stamping it "IT Worker
  // Fraud" because of the file it happens to live in would assert an
  // attribution the source did not make.
  const campaign = entry.campaign || (config.defaults && config.defaults.campaign) || [];
  const photo = photoFor(entry, posts, publisher);
  const photos = photosFor(entry, posts, publisher);
  const resume = resumeFor(entry, posts, publisher);
  const attachments = attachmentsFor(entry, posts, publisher);

  return [...entry.indicators || [], ...derivedAliases(entry)].map((indicator) => {
    const cited = citedPosts(indicator, posts, sectionLabel);
    const dates = cited.map((p) => p.date).filter(Boolean).sort();
    const value = normalizeValue(indicator, sectionLabel);
    const accountStatus =
      indicator.ioc_type === "linkedin_profile"
        ? linkedinAccountStatus(value)
        : indicator.ioc_type === "github_profile"
          ? githubAccountStatus(value)
          : platformAccountStatus(indicator.ioc_type, value);
    const phoneStatus = indicator.ioc_type === "phone_number" ? phoneLineStatus(value) : null;
    return {
      id: recordId(indicator.ioc_type, value),
      ioc_type: indicator.ioc_type,
      value,
      display: null,
      ...(accountStatus ? { account_status: accountStatus } : {}),
      ...(phoneStatus ? { phone_status: phoneStatus } : {}),
      // A password the cited page prints beside this address, such as a
      // credential list committed to the persona's own repository. Operator
      // passwords are published (scripts/build-password-links.js).
      ...(indicator.password && indicator.ioc_type === "email_address"
        ? { password: indicator.password, password_origin: "observed" }
        : {}),
      persona: null,
      persona_key: personaKey,
      persona_anchor: Boolean(personaKey),
      // The name and aliases a dossier states outright. personas.js otherwise
      // reads a persona's name back out of the section label, which is right
      // for a scraped report heading and wrong here: the label is built FROM
      // these fields, and round-tripping it through a heading parser loses any
      // name that parser reads as structure. "4K" — one of ZachXBT's team
      // designations — is discarded as a numbered heading.
      persona_name: persona ? persona.name : null,
      persona_aliases: persona ? persona.aliases : null,
      // "facilitator" for a real person a researcher names as fronting an
      // operation, as against a fabricated identity; the page words itself
      // for which it is.
      persona_role: persona ? persona.role || null : null,
      persona_photo: photo,
      persona_photos: photos,
      persona_resume: resume,
      persona_attachments: attachments,
      campaign: [...campaign],
      first_seen: dates[0] || null,
      last_seen: dates[dates.length - 1] || null,
      extraction: extractionFor(config),
      sources: cited.map((post) => ({
        url: post.url || researcher.account,
        // A post has no title. Naming it by its own URL keeps two posts
        // about the same persona distinguishable in a citation list, which
        // a repeated persona label did not.
        title: (post.url || researcher.account || "").replace(/^https?:\/\//, ""),
        publisher,
        published: post.date || null,
        // The transcriber's note about this entry, where there is one. It is
        // a summary of what the post says around the indicator, which is the
        // same job the scraper's `context` does for a report.
        context: entry.note || "",
        context_origin: entry.note ? "text" : "curated",
        // The lines of the cited page around this value, where the entry
        // carries that page's text. See excerptAround above for why it is
        // kept separate from `context` rather than replacing it: one is the
        // transcriber's account of the entry, the other is the document.
        excerpt: excerptAround(resume && resume.text, indicator.value, value),
        section: sectionLabel,
        // An entry read on a later day than the file's default carries its own
        // date, so the citation says when that page was actually read.
        pulled_at: entry.transcribed || (config.defaults && config.defaults.transcribed) || null,
        source_sha256: null,
      })),
    };
  });
}

/**
 * The posts an indicator cites. `post` is an index into the entry's posts, or
 * a list of them where one value is cited by several (an account the site read
 * itself and the report that named it): one citation per listed post, in
 * order, on one record. An index the entry does not have stops the build, as
 * a value that will not normalize does. A bare number, or none, keeps the
 * older rule of falling back to the first post.
 */
function citedPosts(indicator, posts, label) {
  if (!Array.isArray(indicator.post)) return [posts[indicator.post || 0] || posts[0] || {}];
  if (!indicator.post.length) {
    throw new Error(`x-dossiers.json: ${label} — ${indicator.ioc_type} "${indicator.value}" has an empty post list.`);
  }
  return indicator.post.map((index) => {
    if (!Number.isInteger(index) || !posts[index]) {
      throw new Error(
        `x-dossiers.json: ${label} — ${indicator.ioc_type} "${indicator.value}" cites post ${index}, ` +
          `which the entry does not have (it has ${posts.length}).`
      );
    }
    return posts[index];
  });
}

/**
 * An account on a platform the index can normalize belongs in indicators, not
 * parked in unextracted[]. Values were once parked there "until the platform
 * earns its own type" and stayed there; the rule now is to add the platform to
 * PLATFORM_ACCOUNTS at transcription time. This stops the build when a parked
 * link already normalizes, unless its note gives the reason it is held back.
 */
const ACCOUNT_NORMALIZERS = Object.entries(NORMALIZERS).filter(
  ([type]) => type.endsWith("_account") || type === "github_profile" || type === "linkedin_profile"
);

function assertNothingParkedThatNormalizes(entry, label) {
  for (const parked of entry.unextracted || []) {
    const text = String(parked);
    if (/\bheld\b/i.test(text)) continue;
    const url = (text.match(/^\s*(https?:\/\/\S+)/) || [])[1];
    if (!url) continue;
    for (const [type, normalize] of ACCOUNT_NORMALIZERS) {
      if (normalize(url.replace(/[,.;]+$/, ""))) {
        throw new Error(
          `x-dossiers.json: ${label} — unextracted "${url}" normalizes as ${type}. ` +
            "Move it to indicators, or say in its note why it is held back."
        );
      }
    }
  }
}

/**
 * Every record the dossier file yields, personas and unattributed alike.
 *
 * @param {object} config - the parsed x-dossiers.json.
 * @returns {object[]} records in scraped-iocs.json shape.
 */
function recordsFromDossiers(config) {
  if (!config || !config.researchers) return [];
  const records = [];

  for (const dossier of config.dossiers || []) {
    const label = dossier.aliases && dossier.aliases.length
      ? `${dossier.persona} / ${dossier.aliases.join(" / ")}`
      : dossier.persona;
    assertNothingParkedThatNormalizes(dossier, label);
    // Keyed on the persona alone, not the researcher: two researchers who
    // name the same operator are corroborating, not describing two people.
    records.push(...recordsFor(dossier, config, label, `dossier ${dossier.persona}`, {
      name: dossier.persona,
      aliases: dossier.aliases || [],
      role: dossier.role || null,
    }));
  }

  // Indicators the source published without naming an operator. They reach the
  // index like any other, and they anchor no persona — the whole point is that
  // the researcher declined to attribute them.
  //
  // A group may set its own `label` to say what the set actually is, which
  // reads better on an indicator page than filing everything a source declined
  // to attribute under one generic heading. It changes the section label only;
  // the group still anchors no persona.
  for (const group of config.unattributed || []) {
    assertNothingParkedThatNormalizes(group, group.label || "Unattributed");
    records.push(...recordsFor(group, config, group.label || "Unattributed", null));
  }

  return records;
}

module.exports = { recordsFromDossiers };
