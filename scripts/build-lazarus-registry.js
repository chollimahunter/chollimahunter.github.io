// One-off: map the extracted lazarus.group registry into this repo's dossier schema.
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./lib/write-atomic.js");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "One-off: map the extracted lazarus.group registry into this repo's dossier schema.\n" +
      "usage: node scripts/build-lazarus-registry.js <raw.json> <out.json>"
  );
  process.exit(0);
}

// Which registry images are republished is decided by eye, per image, and
// recorded in scripts/data/lazarus-registry-images.json; see
// scripts/lib/lazarus-registry-images.js. Until 28 September 2026 this script
// took only the first face-tagged image per persona, so 41 approved photos
// never reached the persona pages.
const { registryPhotos, registryAttachments } = require("./lib/lazarus-registry-images.js");

const [, , inPath, outPath] = process.argv;
const personas = JSON.parse(fs.readFileSync(inPath, "utf8"));

const clean = (v) => String(v || "").trim();
const handle = (v) => clean(v).replace(/^@/, "");

/**
 * p.id becomes a path fragment below (the mirrored photo's filename), and it
 * comes out of the registry's own JS bundle rather than anything this repo
 * controls — see safeId() in fetch-lazarus-registry-photos.js, which mirrored
 * the file this reads. An id that doesn't match is treated as having no
 * photo rather than guessed at.
 */
function safeId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(id) ? id : null;
}

// The registry's own fields are not clean: LinkedIn and GitHub URLs turn up
// inside `personal_emails`. Trusting the field name would publish a profile URL
// as an email address, so every value is re-classified by its shape and anything
// that still fails its type's normalizer is dropped rather than guessed at.
const {
  normalizeEmail,
  normalizeGithub,
  normalizeLinkedin,
  normalizeWallet,
  normalizeEns,
  PLATFORM_ACCOUNTS,
  normalizePlatformAccount,
  normalizePhone,
} = require("./lib/ioc-normalize.js");

const platform = (type) =>
  normalizePlatformAccount(PLATFORM_ACCOUNTS.find((s) => s.ioc_type === type));

const NORMALIZE = {
  email_address: normalizeEmail,
  github_profile: normalizeGithub,
  linkedin_profile: normalizeLinkedin,
  wallet_address: normalizeWallet,
  ens_name: normalizeEns,
  telegram_account: platform("telegram_account"),
  x_account: platform("x_account"),
  // E.164, like every other phone in the index: the registry prints the same
  // number in several punctuations, and carrying those through files one line as
  // several indicators. See normalizePhone in lib/ioc-normalize.js.
  phone_number: normalizePhone,
};

/** The type a value actually is, whatever field it was filed under. */
function classify(declared, value) {
  const v = clean(value).toLowerCase();
  if (/(^|\/\/|\.)linkedin\.com\//.test(v)) return "linkedin_profile";
  if (/(^|\/\/|\.)github\.com\//.test(v)) return "github_profile";
  if (/(^|\/\/|\.)t\.me\//.test(v)) return "telegram_account";
  if (/(^|\/\/|\.)(x|twitter)\.com\//.test(v)) return "x_account";
  if (v.includes("@") && !v.includes("/")) return "email_address";
  // The registry files ENS names in with the wallet addresses; this repo has a
  // type for them, so they are kept as what they are rather than dropped.
  if (/^[a-z0-9][a-z0-9-]{2,62}\.eth$/.test(v)) return "ens_name";
  return declared;
}

const dropped = [];

const dossiers = [];
let skippedWebsites = 0;

for (const p of personas) {
  const indicators = [];
  const seen = new Set();
  const push = (declared, value) => {
    const raw = clean(value);
    if (!raw) return;
    const ioc_type = classify(declared, raw);
    const normalize = NORMALIZE[ioc_type];
    const v = normalize ? normalize(raw) : raw;
    if (!v) {
      dropped.push(`${p.id}: ${declared} "${raw}"`);
      return;
    }
    const key = ioc_type + "|" + String(v).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    indicators.push({ ioc_type, value: v });
  };

  for (const email of p.personal_emails || []) push("email_address", email);
  for (const phone of p.phone_numbers || []) push("phone_number", phone);
  for (const tw of p.twitter_usernames || []) push("x_account", "https://x.com/" + handle(tw));

  for (const gh of p.github || []) {
    // Only the account id. The sibling `usernames` are that same account's
    // rename history, and GitHub frees an abandoned name for anyone to claim —
    // publishing each as its own profile would invent accounts.
    if (gh.gh_id) push("github_profile", "https://github.com/" + handle(gh.gh_id));
    for (const email of gh.emails || []) push("email_address", email);
  }

  for (const li of p.linkedin || []) {
    if (li.id) push("linkedin_profile", "https://www.linkedin.com/in/" + handle(li.id));
    for (const email of li.emails || []) push("email_address", email);
  }

  for (const tg of p.telegram || []) {
    for (const name of tg.usernames || []) push("telegram_account", "https://t.me/" + handle(name));
  }

  for (const salary of p.salary_details || []) {
    for (const address of salary.addresses || []) push("wallet_address", address);
  }

  // `onchain_activity` is the registry's own "Wallet Addresses" block, which the
  // persona pages render under that heading and annotate per address ("Metaplay
  // Theft" on one of Jikun Liao's). It is the operator's attributed addresses,
  // not a list of counterparties, so it belongs with the payroll addresses above.
  //
  // Missing it dropped four personas entirely -- James Zook, Joel Kursala,
  // Wubone and Eric Manager have no email or account in the registry, so an
  // address was their only indicator and `if (!indicators.length) continue`
  // discarded them along with it.
  for (const activity of p.onchain_activity || []) {
    const addresses = Array.isArray(activity.address) ? activity.address : [activity.address];
    for (const address of addresses) push("wallet_address", address);
  }

  // `websites` is deliberately dropped. It is the registry's EVIDENCE list, not
  // the operator's infrastructure: alongside a couple of persona portfolio
  // domains it holds justice.gov press releases, Medium write-ups about the
  // victim projects, cryptototem project pages and x.com status links.
  // Publishing those as DPRK indicators would name victims and the DOJ as
  // infrastructure. `associates` is dropped for the same reason — those are
  // cross-references to OTHER personas in this same registry, and copying them
  // here would attribute one operator's accounts to another.
  skippedWebsites += (p.websites || []).length;

  if (!indicators.length) continue;

  const nameFromId = p.id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const name = clean(p.real_name) || clean((p.fake_names || [])[0]) || nameFromId;
  const aliases = [...new Set([...(p.fake_names || []), ...(p.aliases || [])].map(clean))]
    .filter((a) => a && a !== name);

  // Every image recorded as used, whose mirrored file is on disk. An id that
  // is not a plain slug gets none: it comes out of the registry's own bundle.
  const safePersonaId = safeId(p.id);
  if (!safePersonaId) console.warn(`  unsafe persona id, no photos attached: ${JSON.stringify(p.id)}`);
  const { photo, photos } = safePersonaId ? registryPhotos(p) : { photo: null, photos: [] };
  const attachments = safePersonaId ? registryAttachments(p) : [];

  dossiers.push({
    persona: name,
    researcher: "lazarusgroup",
    aliases,
    posts: [{ url: "https://lazarus.group/team/" + p.id, date: null }],
    ...(photo ? { photo } : {}),
    ...(photos.length ? { photos } : {}),
    ...(attachments.length ? { attachments } : {}),
    note:
      "Entry in the lazarus.group DPRK IT-worker registry, which asserts that these accounts belong to one operator" +
      (p.real_citizenships && p.real_citizenships.length
        ? " and gives their real citizenship as " + p.real_citizenships.join(", ")
        : "") +
      ". The registry publishes no methodology, so this is recorded as its claim and not as a finding of this site. Its evidence links and its cross-references to other operators in the same registry are deliberately not reproduced as indicators.",
    indicators,
  });
}

const out = {
  _comment:
    "Third-party indicator registries that publish per-persona dossiers. Same schema as x-dossiers.json and loaded by the same code (scripts/lib/dossiers.js), kept separate because the provenance differs: an X post is one researcher's public claim, a registry is a standing database. See docs/third-party-registries.md.",
  // The day this pull was taken, which becomes every record's pulled_at. A
  // registry entry carries no date of its own, so when the values were read is
  // the only date there is. Overridable so a re-run can be stamped with the day
  // the chunk was actually downloaded rather than the day the script is run.
  defaults: {
    campaign: ["IT Worker Fraud"],
    transcribed: process.env.REGISTRY_PULLED_AT || new Date().toISOString().slice(0, 10),
    method: "registry",
  },
  researchers: {
    lazarusgroup: {
      publisher: "Lazarus Group DPRK IT-Worker Registry (lazarus.group)",
      account: "https://lazarus.group/team",
    },
  },
  dossiers,
};

writeFileAtomic(outPath, JSON.stringify(out, null, 2) + "\n");

const counts = {};
for (const d of dossiers) for (const i of d.indicators) counts[i.ioc_type] = (counts[i.ioc_type] || 0) + 1;
console.log("personas kept:", dossiers.length, "of", personas.length);
console.log("indicators:", JSON.stringify(counts));
console.log("website/evidence URLs deliberately dropped:", skippedWebsites);
console.log("personas with a mirrored photo:", dossiers.filter((d) => d.photo).length);
console.log("values dropped as unnormalizable:", dropped.length);
dropped.slice(0, 20).forEach((d) => console.log("   " + d));
