/**
 * ioc-normalize.test.js — table-driven tests for scripts/lib/ioc-normalize.js
 * ==========================================================================
 * Every case here is taken from that module's own comments — the worked
 * examples the code was written to handle (a specific dotted Gmail address,
 * a specific reverse-DNS package name, the three empty-file digests) rather
 * than invented inputs. Run with `node --test scripts/lib/`.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EMAIL_PATTERN,
  isEmailFragment,
  LINKEDIN_PATTERN,
  normalizeEmail,
  normalizePhone,
  NPM_TABLE_ROW_PATTERN,
  isHostileTableRow,
  PHONE_PATTERN,
  looksLikePhoneContext,
  isPhoneBoilerplate,
  normalizeWallet,
  walletChain,
  normalizeFileHash,
  normalizeDomain,
  isExcludedDomain,
  normalizePlatformAccount,
  PLATFORM_ACCOUNTS,
  isVictimSection,
} = require("./ioc-normalize.js");

function runTable(name, fn, cases) {
  test(name, () => {
    for (const [label, input, expected] of cases) {
      assert.deepEqual(fn(input), expected, `${name}(${JSON.stringify(input)}) [${label}]`);
    }
  });
}

// ---------------------------------------------------------------------------
// normalizeEmail — Gmail dot/plus folding, googlemail.com, other hosts
// untouched, invalid rejected. Cases from the comment above canonicalMailbox
// and normalizeEmail in ioc-normalize.js.
// ---------------------------------------------------------------------------
runTable("normalizeEmail", normalizeEmail, [
  ["dotted googlemail folds to canonical gmail", "a.l.l.a.nh.orca0.7@googlemail.com", "allanhorca07@gmail.com"],
  ["a second dotted spelling of the same mailbox folds identically", "al.la.n.h.o.rca07@gmail.com", "allanhorca07@gmail.com"],
  ["a plus tag is dropped on Gmail", "edmonddantes000313+1@gmail.com", "edmonddantes000313@gmail.com"],
  ["a two-digit plus tag is dropped the same way", "edmonddantes000313+32@gmail.com", "edmonddantes000313@gmail.com"],
  ["a dot on a non-Gmail host is a real, distinct mailbox and is kept", "a.smith@outlook.com", "a.smith@outlook.com"],
  ["a non-Gmail host is only lowercased, not dot-folded", "A.Smith@Outlook.com", "a.smith@outlook.com"],
  ["two consecutive dots mark a publisher's masked address and are rejected", "jb.....@gmail.com", null],
  ["not an email address at all", "not-an-email", null],
  ["Gmail folding also lowercases the whole address", "Foo.Bar@GMAIL.com", "foobar@gmail.com"],
]);

// ---------------------------------------------------------------------------
// normalizePhone — E.164 cases from the comment above normalizePhone.
// ---------------------------------------------------------------------------
runTable("normalizePhone", normalizePhone, [
  ["a spaced +1 number loses its separators", "+1 832 706 3757", "+18327063757"],
  ["an 11-digit NANP number with no plus gets one", "18327063757", "+18327063757"],
  ["a hyphenated bare NANP number is assumed NANP and canonicalized", "419-746-0450", "+14197460450"],
  ["the same number written with a country code collapses to the same value", "+1-419-746-0450", "+14197460450"],
  ["the same number written as a bare 11-digit run also collapses to it", "14197460450", "+14197460450"],
  ["a value that already states its country code is trusted even if short", "+1753362648", "+1753362648"],
  ["a bare 10-digit number is assumed NANP", "8327063757", "+18327063757"],
  ["letters in a phone-shaped string are rejected", "1-800-CALL-NOW", null],
  ["more digits than E.164 allows is rejected", "123456789012345678", null],
  ["an empty string is rejected", "", null],
  ["a Chinese mobile printed without a plus is trusted on its 86 prefix", "8613341122552", "+8613341122552"],
  ["a Chinese mobile, second GitLab row", "8618811177571", "+8618811177571"],
  ["a Chinese mobile, third GitLab row", "8617701222967", "+8617701222967"],
  ["a Chinese mobile, fourth GitLab row", "8618911321235", "+8618911321235"],
  ["a Chinese mobile, fifth GitLab row", "8619910229812", "+8619910229812"],
  ["a Chinese mobile, sixth GitLab row", "8613381035676", "+8613381035676"],
  ["a bare ten-digit NANP number", "4696382784", "+14696382784"],
  ["an eleven-digit NANP number", "15414257086", "+15414257086"],
  ["a Russian trunk-prefix mobile becomes +7 and the last ten digits", "89883507137", "+79883507137"],
  ["an eleven-digit NANP number, Utah", "14358179097", "+14358179097"],
  ["a bare ten-digit NANP number, 350 area", "3508704464", "+13508704464"],
  ["a bare ten-digit NANP number, 479 area", "4796004206", "+14796004206"],
  ["a bare ten-digit NANP number, 559 area", "5596103595", "+15596103595"],
  ["a hyphenated Chinese mobile with no plus", "86-186-4155-7481", "+8618641557481"],
  ["a 64-hex hash fragment is not a phone number", "3f2a9c1d8e7b4a65", null],
  ["a Unix timestamp has an area code starting with 1", "1727712000", null],
  ["a NANP-length number whose area code starts with 0 is rejected", "0123456789", null],
  ["a NANP number whose area code starts with 1 is rejected", "1234567890", null],
  ["a NANP number whose exchange starts with 1 is rejected", "4691382784", null],
  ["a NANP number whose exchange starts with 0 is rejected", "4690382784", null],
  ["an 11-digit number with no recognised prefix is rejected", "25414257086", null],
  ["a 13-digit number not starting 861 is rejected", "8523341122552", null],
  ["an ISO date and hour is not a phone number", "2026-03-16 11", null],
  ["an IPv4 address is not a phone number", "39.144.60.174", null],
]);

// ---------------------------------------------------------------------------
// normalizeWallet / walletChain — Ethereum lowercased, Aptos, Bitcoin
// (base58 and bc1), Tron, Solana, and an MD5-shaped hex string rejected.
// ---------------------------------------------------------------------------
test("walletChain identifies the chain from an address's shape", () => {
  assert.equal(walletChain("0xAbCdEf1234567890aBcDeF1234567890ABCDEF12"), "Ethereum");
  assert.equal(walletChain("0x" + "aB".repeat(32)), "Aptos");
  // Straight from the comment above WALLET_PATTERNS: a Bitcoin address that a
  // looser Solana pattern once misread.
  assert.equal(walletChain("1HmqvgSXUVES1jn4TQPzk9dxo1NE8wim2T"), "Bitcoin");
  assert.equal(walletChain("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"), "Bitcoin");
  assert.equal(walletChain("TABCDEFGHJKLMNPQRSTUVWXYZabcdefghi"), "Tron");
  assert.equal(walletChain("AABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrs"), "Solana");
  // A run of hex exactly an MD5's length is a file hash, whatever else it
  // resembles — see the comment above walletChain.
  assert.equal(walletChain("d41d8cd98f00b204e9800998ecf8427e"), null);
});

test("normalizeWallet lowercases hex chains and preserves base58 case", () => {
  assert.equal(
    normalizeWallet("0xAbCdEf1234567890aBcDeF1234567890ABCDEF12"),
    "0xabcdef1234567890abcdef1234567890abcdef12"
  );
  assert.equal(normalizeWallet("0x" + "aB".repeat(32)), "0x" + "ab".repeat(32));
  assert.equal(normalizeWallet("1HmqvgSXUVES1jn4TQPzk9dxo1NE8wim2T"), "1HmqvgSXUVES1jn4TQPzk9dxo1NE8wim2T");
  assert.equal(normalizeWallet("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"), "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
  assert.equal(normalizeWallet("TABCDEFGHJKLMNPQRSTUVWXYZabcdefghi"), "TABCDEFGHJKLMNPQRSTUVWXYZabcdefghi");
  assert.equal(normalizeWallet("d41d8cd98f00b204e9800998ecf8427e"), null);
});

// ---------------------------------------------------------------------------
// XRP Ledger and Zcash transparent addresses: base58check, so a checksum
// failure, a wrong length or an ordinary word is refused.
// ---------------------------------------------------------------------------
const XRP_ZCASH_CASES = [
  ["Bitget XRP address", "rwNhefsz1UQEusxhCvHip3RANinWi4CTck", "XRP Ledger"],
  ["XRP genesis account", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "XRP Ledger"],
  ["XRP address of 27 characters", "rrrrrrrrrrrrrrrrrrrrrhoLvTp", "XRP Ledger"],
  ["Bitget Zcash t1 address", "t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG", "Zcash"],
  ["Zcash t1 address", "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "Zcash"],
  ["Zcash t3 address", "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd", "Zcash"],
  ["XRP address with a bad checksum", "rwNhefsz1UQEusxhCvHip3RANinWi4CTcj", null],
  ["Zcash address with a bad checksum", "t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVh", null],
  ["XRP address too short", "rwNhefsz1UQEusxhCvHip3RA", null],
  ["XRP address too long", "rwNhefsz1UQEusxhCvHip3RANinWi4CTckk", null],
  ["Zcash address too short", "t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDV", null],
  ["an English word starting with r", "registrationcertificatesyst", null],
  ["a Tron address stays Tron", "TMfKQEd7TJJa5xNZJZ2Lep838vrzrs7mAP", "Tron"],
  ["a Bitcoin address stays Bitcoin", "1HmqvgSXUVES1jn4TQPzk9dxo1NE8wim2T", "Bitcoin"],
];

for (const [name, input, chain] of XRP_ZCASH_CASES) {
  test(`walletChain: ${name}`, () => {
    assert.equal(walletChain(input), chain);
    assert.equal(normalizeWallet(input), chain ? input : null);
  });
}

// ---------------------------------------------------------------------------
// normalizeFileHash — 32/40/64 accepted, uppercase lowered, the three
// empty-file digests rejected, wrong length rejected.
// ---------------------------------------------------------------------------
runTable("normalizeFileHash", normalizeFileHash, [
  ["a 32-char MD5-shaped hash is accepted and lowercased", "5D41402ABC4B2A76B9719D911017C592", "5d41402abc4b2a76b9719d911017c592"],
  ["a 40-char SHA-1-shaped hash is accepted and lowercased", "AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D", "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"],
  [
    "a 64-char SHA-256-shaped hash is accepted",
    "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  ],
  ["the empty-file MD5 is rejected", "d41d8cd98f00b204e9800998ecf8427e", null],
  ["the empty-file SHA-1 is rejected", "da39a3ee5e6b4b0d3255bfef95601890afd80709", null],
  ["the empty-file SHA-256 is rejected", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", null],
  ["one character short of a valid length is rejected", "5d41402abc4b2a76b9719d911017c5", null],
  ["non-hex characters are rejected even at a valid length", "z".repeat(32), null],
]);

// ---------------------------------------------------------------------------
// normalizeDomain / isExcludedDomain — a few cases from the comments above
// DOMAIN_PATTERN and REVERSE_DNS_HEADS.
// ---------------------------------------------------------------------------
runTable("normalizeDomain", normalizeDomain, [
  ["scheme and www are stripped and the host is lowercased", "https://WWW.Example.COM/path?x=1", "example.com"],
  // The comment's own worked example: an Android package name read as a domain.
  ["a reverse-DNS package name is rejected, not a hostname", "com.hyundaipay.hdac", null],
  ["an ordinary three-label host under .com is not reverse-DNS", "dev.azure.com", "dev.azure.com"],
  ["an ordinary three-label host under .org is not reverse-DNS", "me.example.org", "me.example.org"],
  ["a dotted-quad IP address is not a domain", "1.2.3.4", null],
]);

test("isExcludedDomain excludes known non-indicator hosts and passes an ordinary one", () => {
  assert.equal(isExcludedDomain("gmail.com"), true);
  // Already carried as its own hosted_site type; see the comment above
  // isExcludedDomain for the Socket.dev tetrismic.vercel.app example.
  assert.equal(isExcludedDomain("tetrismic.vercel.app"), true);
  assert.equal(isExcludedDomain("polygon-rpc.com"), true);
  assert.equal(isExcludedDomain("somewallet.eth"), true);
  assert.equal(isExcludedDomain("regioncheck.net"), false);
});

test("platform accounts added for persona-site contacts canonicalize and refuse non-accounts", () => {
  const normalize = (type) =>
    normalizePlatformAccount(PLATFORM_ACCOUNTS.find((spec) => spec.ioc_type === type));
  const cases = [
    ["facebook_account", "https://www.facebook.com/profile.php?id=100094738357604", "https://facebook.com/profile.php?id=100094738357604"],
    ["facebook_account", "https://www.facebook.com/Superdev0909", "https://facebook.com/superdev0909"],
    ["facebook_account", "https://www.facebook.com/sharer/sharer.php?u=", null],
    ["facebook_account", "https://www.facebook.com/profile.php", null],
    ["facebook_account", "https://www.facebook.com/people/Ninja-Development-LLC/100070818228999", "https://facebook.com/profile.php?id=100070818228999"],
    ["instagram_account", "https://www.instagram.com/youthdream0925/", "https://instagram.com/youthdream0925"],
    ["instagram_account", "https://www.instagram.com/p/C1x2y3z/", null],
    ["stackoverflow_account", "https://stackoverflow.com/users/20008661/daniel-jin", "https://stackoverflow.com/users/20008661"],
    ["stackoverflow_account", "https://stackoverflow.com/questions/123", null],
    ["discord_account", "https://discord.com/users/1048479537442328617", "https://discord.com/users/1048479537442328617"],
    ["discord_account", "https://discord.com/users/lucast06106", "https://discord.com/users/lucast06106"],
    ["discord_account", "https://discord.com/channels/123", null],
    ["nineamworks_account", "https://app.9am.works/talent/derek-otieno", "https://app.9am.works/talent/derek-otieno"],
    ["nineamworks_account", "app.9am.works/talent/Emmanuel-Greene/", "https://app.9am.works/talent/emmanuel-greene"],
    ["nineamworks_account", "https://app.9am.works/talent", null],
    ["nineamworks_account", "https://app.9am.works/jobs/derek", null],
  ];
  for (const [type, raw, expected] of cases) assert.equal(normalize(type)(raw), expected, raw);
});

// ---------------------------------------------------------------------------
// Timing regression — EMAIL_PATTERN and LINKEDIN_PATTERN are bounded so an
// adversarial run of eligible characters with no terminator is not rescanned
// from every starting position. See the comment above EMAIL_PATTERN: an
// unbounded quantifier over a 160KB run of "1.1.1." cost 25 seconds.
// ---------------------------------------------------------------------------
test("isEmailFragment rejects masked tails, URL logins and bounce addresses, and passes whole addresses", () => {
  const cases = [
    // [text, the address as the pattern matched it, expected]
    ["su******d@hotmail.com", "d@hotmail.com", true],
    ["h****_u@hotmail.com", "_u@hotmail.com", true],
    ["ftp://root:1q2w3e4r%T^Y&U*I@lianxinxiao.com/x", "I@lianxinxiao.com", true],
    ["ftp://u:u@b.smtper.co/beta", "u@b.smtper.co", true],
    ["no-reply+036d5d(d)0-3bd4-11f0-86c1-5254007ea3ec_vt1@bounce-zem.invoicdev.64bit.kr", "0-3bd4-11f0-86c1-5254007ea3ec_vt1@bounce-zem.invoicdev.64bit.kr", true],
    ["contact: jane.doe@gmail.com.", "jane.doe@gmail.com", false],
    ["mailto:jane@example.com", "jane@example.com", false],
    ["(jane@example.com)", "jane@example.com", false],
    ["<jane@example.com>", "jane@example.com", false],
    ["https://sg24.vps.bz:4083/center2025a@tutamail.com", "center2025a@tutamail.com", false],
    ["https://mvitalii206@bitbucket.org/eiwork_hire/", "mvitalii206@bitbucket.org", true],
  ];
  for (const [text, address, expected] of cases) {
    const index = text.lastIndexOf(address);
    assert.equal(isEmailFragment(text, index, [address]), expected, text);
  }
});

test("EMAIL_PATTERN stays linear on a 160,000-character adversarial string", () => {
  const adversarial = "1.1.".repeat(40000);
  const start = Date.now();
  adversarial.match(EMAIL_PATTERN);
  assert.ok(Date.now() - start < 1000, "EMAIL_PATTERN took too long on the adversarial input");
});

test("LINKEDIN_PATTERN stays linear on a 160,000-character adversarial string", () => {
  const adversarial = "linkedin.com/in/" + "a-".repeat(80000);
  const start = Date.now();
  adversarial.match(LINKEDIN_PATTERN);
  assert.ok(Date.now() - start < 1000, "LINKEDIN_PATTERN took too long on the adversarial input");
});

test("isVictimSection catches infected-repository tables but not infection chains", () => {
  for (const label of ["Infected repositories", "Poisoned packages", "Infected developers"]) {
    assert.equal(isVictimSection(label), true, label);
  }
  for (const label of ["Infection chain", "Additional DTrack module and initial infection method", "Infection Timeline"]) {
    assert.equal(isVictimSection(label), false, label);
  }
});

// ---------------------------------------------------------------------------
// Phone context gate — a digit run is a number only where a label sits with it.
// ---------------------------------------------------------------------------
function phoneMatches(text, section = null) {
  const out = [];
  for (const m of text.matchAll(new RegExp(PHONE_PATTERN.source, PHONE_PATTERN.flags))) {
    if (!looksLikePhoneContext(text, m.index, section)) continue;
    if (isPhoneBoilerplate(text, m.index, m[0].length)) continue;
    const value = normalizePhone(m[0]);
    if (value) out.push(value);
  }
  return out;
}

test("a table row labelled as a phone number is accepted", () => {
  assert.deepEqual(phoneMatches("\n 4696382784 phone number insider N/A N/A Threat actor persona phone number 3 \n"), ["+14696382784"]);
});

test("the same digits with no label are ignored", () => {
  assert.deepEqual(phoneMatches("\n 4696382784 domain insider N/A N/A Threat actor persona 3 \n"), []);
});

test("a label within 40 characters before the value in prose is accepted", () => {
  assert.deepEqual(phoneMatches("The listing gave the phone number +1 7127594675 for her."), ["+17127594675"]);
});

test("a label further than 40 characters back in a long paragraph does not count", () => {
  const filler = "x ".repeat(130);
  assert.deepEqual(phoneMatches("Phone support was discussed. " + filler + "Then 4696382784 appeared."), []);
});

test("a heading about phone numbers labels the values under it", () => {
  assert.deepEqual(phoneMatches("\n4696382784\n", "Phone Numbers"), ["+14696382784"]);
});

test("a hash, a timestamp and a date near the word phone are not numbers", () => {
  const text = "Phone malware sample 3f2a9c1d8e7b4a65 seen at 1727712000 on 2026-03-16 11:23:08 from 39.144.60.174";
  assert.deepEqual(phoneMatches(text), []);
});

test("a publisher's address block and a WHOIS record are refused", () => {
  assert.deepEqual(phoneMatches("225 East John Carpenter Freeway Suite 1500 Irving Phone: +1 (817) 569-8900"), []);
  assert.deepEqual(phoneMatches("Registrant Phone: +1.8133205751 Registrant Email: a@b.example"), []);
});

// ---------------------------------------------------------------------------
// npm package rows of an indicator table — the row's type column is the context.
// ---------------------------------------------------------------------------
function npmRows(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(NPM_TABLE_ROW_PATTERN.source, NPM_TABLE_ROW_PATTERN.flags))) {
    if (isHostileTableRow(text, m.index)) out.push(m[1]);
  }
  return out;
}

test("a table row typed npm package and called malicious is taken", () => {
  const row = "\n dotenv-extend npm package malware N/A N/A Malicious NPM dependency used to deliver malware Year in Review \n";
  assert.deepEqual(npmRows(row), ["dotenv-extend"]);
});

test("a scoped package in a typed row is taken whole", () => {
  assert.deepEqual(npmRows("\n@scope/evil-pkg npm package malware N/A N/A Malicious dependency \n"), ["@scope/evil-pkg"]);
});

test("a legitimate dependency named in prose is never taken", () => {
  assert.deepEqual(npmRows("The loader imports dotenv and express before it runs, which is malware behaviour."), []);
  assert.deepEqual(npmRows("dotenv is a widely used package that the malware imitates."), []);
});

test("a row typed npm package that does not call it hostile is refused", () => {
  assert.deepEqual(npmRows("\nexpress npm package targeted N/A N/A Legitimate package that was targeted \n"), []);
});

test("a sentence that begins with a package name and the words npm package needs a hostile word", () => {
  assert.deepEqual(npmRows("\nexpress npm package is the most popular web framework for Node.js\n"), []);
});

// ---------------------------------------------------------------------------
// payload_url — a full URL on a shared paste or JSON-bin service.
// ---------------------------------------------------------------------------
const {
  normalizePayloadUrl,
  PAYLOAD_URL_HOSTS,
} = require("./ioc-normalize.js");

runTable("normalizePayloadUrl", normalizePayloadUrl, [
  ["a bin URL as written", "https://jsonkeeper.com/b/4NAKK", "https://jsonkeeper.com/b/4NAKK"],
  ["scheme and host lowercased, path case kept", "HTTPS://JsonKeeper.COM/b/4NAKK", "https://jsonkeeper.com/b/4NAKK"],
  ["defanged scheme and dot", "hxxps://api[.]npoint[.]io/0123abcd", "https://api.npoint.io/0123abcd"],
  ["no scheme", "api.mocki.io/v2/abc123", "https://api.mocki.io/v2/abc123"],
  ["fragment dropped", "https://jsonkeeper.com/b/4NAKK#top", "https://jsonkeeper.com/b/4NAKK"],
  ["tracking parameters dropped, others kept", "https://pastebin.com/raw/Ab12?utm_source=x&id=7&fbclid=y", "https://pastebin.com/raw/Ab12?id=7"],
  ["trailing punctuation", "https://jsonkeeper.com/b/4NAKK).", "https://jsonkeeper.com/b/4NAKK"],
  ["a host outside the list is still a payload URL when the report types the row", "http://chainlink-api-v3.cloud/api/service/token/3ae1d04a7c1a35b9edf045a7d131c4a7", "http://chainlink-api-v3.cloud/api/service/token/3ae1d04a7c1a35b9edf045a7d131c4a7"],
  ["bare host", "https://jsonkeeper.com", null],
  ["bare host with a slash", "https://jsonkeeper.com/", null],
  ["bare host, no scheme", "jsonkeeper.com", null],
  ["not http", "ftp://jsonkeeper.com/b/4NAKK", null],
  ["credentials in the address", "https://user:pw@jsonkeeper.com/b/4NAKK", null],
  ["empty", "", null],
]);

test("the payload URL host list is apexes, and a service host alone is not a domain", () => {
  for (const host of PAYLOAD_URL_HOSTS) {
    assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    assert.equal(isExcludedDomain(host), true, `${host} as a bare domain`);
  }
  assert.equal(isExcludedDomain("api.npoint.io"), true);
});

test("payload_url extraction: listed hosts in malicious context, and hostile table rows", () => {
  const { extractFrom } = require("../scrape-dprk-iocs.js");
  const values = (prose) =>
    extractFrom(prose, [], {})
      .filter((a) => a.ioc_type === "payload_url")
      .map((a) => a.value);

  // A listed host, in a sentence about malware, is taken whole.
  assert.deepEqual(
    values("The BeaverTail malware downloads its next stage from https://jsonkeeper.com/b/4NAKK and runs it."),
    ["https://jsonkeeper.com/b/4NAKK"]
  );
  // The same host with no malicious context is not.
  assert.deepEqual(values("We stored the example config at https://jsonkeeper.com/b/ABCDE for the demo."), []);
  // The host without a path is not an indicator, and is not a domain either.
  const bare = extractFrom("The malware used JSON Keeper (jsonkeeper.com) as a dead drop.", [], {});
  assert.deepEqual(bare.filter((a) => a.ioc_type === "payload_url" || a.ioc_type === "domain"), []);

  // A table row typed url and called malware takes a URL on any host.
  const rows =
    "\n https://jsonkeeper.com/b/XV3WO url malware N/A N/A JavaScript malware dropper URL Year in Review \n" +
    "\n http://chainlink-api-v3.cloud/api/service/token/3ae1d04a7c1a35b9edf045a7d131c4a7 url malware N/A N/A JavaScript malware dropper URL Year in Review \n";
  assert.deepEqual(values(rows).sort(), [
    "http://chainlink-api-v3.cloud/api/service/token/3ae1d04a7c1a35b9edf045a7d131c4a7",
    "https://jsonkeeper.com/b/XV3WO",
  ]);
  // A free-hosting subdomain stays a hosted_site and is not doubled as a URL.
  const vercel = "\n https://jwt-alpha-woad.vercel.app/api url malware N/A N/A JavaScript malware dropper URL Year in Review \n";
  assert.deepEqual(values(vercel), []);
  // A row that does not call itself hostile is refused.
  assert.deepEqual(values("\n https://example.org/docs/page url reference N/A N/A Vendor documentation \n"), []);
});

test("an IOC heading word is not an npm package", () => {
  const { normalizeNpmPackage } = require("./ioc-normalize.js");
  assert.equal(normalizeNpmPackage("malicious"), null);
  assert.equal(normalizeNpmPackage("Packages"), null);
  assert.equal(normalizeNpmPackage("is-buffer-validator"), "is-buffer-validator");
  assert.equal(normalizeNpmPackage("@scope/malicious"), "@scope/malicious");
});
