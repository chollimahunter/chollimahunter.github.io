/**
 * publishers.js — one spelling of a publisher's name per host
 * ==========================================================================
 * Citations are written by hand, by the scraper and by discovery, and the same
 * host arrived under several names: cloud.google.com seven ways, justice.gov
 * five, and a few derived from the host itself ("Att", "Clearskysec"). Applied
 * when the index and the source registry are built, so the data files keep
 * what they were written with and every page shows one name.
 *
 * Keyed by host without "www.". A Wayback capture is looked up by the host it
 * captured. A host that carries many authors by design (medium.com, x.com,
 * dev.to, a joint government advisory) is left out, and so is a citation this
 * site published itself, which names Chollima Hunter.
 */
"use strict";

const CANONICAL_PUBLISHERS = {
  "38north.org": "38 North",
  "abnormal.ai": "Abnormal AI",
  "allsecure.io": "AllSecure",
  "alyacofficialblog.tistory.com": "ESTsecurity ALYac",
  "any.run": "ANY.RUN",
  "asec.ahnlab.com": "AhnLab ASEC",
  "attack.mitre.org": "MITRE",
  "blog.alyac.co.kr": "ESTsecurity ALYac",
  "blog.grumpygoose.io": "Grumpy Goose Labs",
  "blog.nviso.eu": "NVISO",
  "blog.polyswarm.io": "PolySwarm",
  "blog.sekoia.io": "Sekoia",
  "blogs.jpcert.or.jp": "JPCERT/CC",
  "chollima-group.io": "Chollima Group",
  "clearskysec.com": "ClearSky Cyber Security",
  "cloud.google.com": "Google Threat Intelligence Group",
  "cybersecurity.att.com": "AT&T Alien Labs",
  "cyfirma.com": "CYFIRMA",
  "documents.un.org": "UN Security Council Panel of Experts (1718 Committee)",
  "dprk-research.kmsec.uk": "Kieran Miyamoto (kmsec)",
  "dtex.ai": "DTEX Systems",
  "dti.domaintools.com": "DomainTools",
  "elastic.co": "Elastic Security Labs",
  "falconfeeds.io": "FalconFeeds",
  "gbhackers.com": "GBHackers on Security",
  "genians.co.kr": "Genians",
  "group-ib.com": "Group-IB",
  "home.treasury.gov": "U.S. Department of the Treasury",
  "huntress.com": "Huntress",
  "igloopedia.com": "IGLOO Security",
  "intel.breakglass.tech": "Break Glass Intelligence",
  "jamf.com": "Jamf Threat Labs",
  "jp.security.ntt": "NTT Security Japan",
  "justice.gov": "U.S. Department of Justice",
  "kmsec.uk": "Kieran Miyamoto (kmsec)",
  "levelblue.com": "LevelBlue",
  "mandiant.com": "Mandiant",
  "microsoft.com": "Microsoft",
  "mofa.go.kr": "Ministry of Foreign Affairs, Republic of Korea",
  "moonlock.com": "Moonlock",
  "msmt.info": "Multilateral Sanctions Monitoring Team (MSMT)",
  "nisos.com": "Nisos",
  "nkinternet.com": "NKInternet",
  "nkinternet.wordpress.com": "NKInternet",
  "northscan.co": "North Scan",
  "objective-see.org": "Objective-See",
  "opensourcemalware.com": "OpenSourceMalware",
  "panther.com": "Panther Labs",
  "piyolog.hatenadiary.jp": "piyokango",
  "quetzal.bitso.com": "Bitso",
  "quillaudits.com": "QuillAudits",
  "recordedfuture.com": "Recorded Future",
  "rekt.news": "Rekt",
  "reversinglabs.com": "ReversingLabs",
  "secai.ai": "Sec AI",
  "sect.iij.ad.jp": "IIJ Security Diary",
  "securelist.com": "Kaspersky Securelist",
  "secureworks.com": "Secureworks (Sophos)",
  "securitylabs.datadoghq.com": "Datadog Security Labs",
  "sentinelone.com": "SentinelOne",
  "silentpush.com": "Silent Push",
  "slowmist.medium.com": "SlowMist",
  "socket.dev": "Socket",
  "somedieyoungzz.github.io": "somedieyoung ZZ",
  "sophos.com": "Sophos",
  "taylor-blog.issuemakerslab.com": "Issuemakers Lab",
  "thehackernews.com": "The Hacker News",
  "theravenfile.com": "The Raven File",
  "ti.qianxin.com": "QiAnXin Threat Intelligence",
  "trmlabs.com": "TRM Labs",
  "unit42.paloaltonetworks.com": "Unit 42",
  "wezard4u.tistory.com": "wezard4u",
  "wired.com": "WIRED",
  "zscaler.com": "Zscaler",
};

const WAYBACK = /^https?:\/\/web\.archive\.org\/web\/[^/]+\/(https?:\/\/.+)$/i;

function publisherHost(url) {
  if (typeof url !== "string") return null;
  const captured = url.match(WAYBACK);
  try {
    return new URL(captured ? captured[1] : url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The publisher a citation should show: the host's one spelling where it has one. */
function canonicalPublisher(url, publisher) {
  if (typeof publisher === "string" && /^Chollima Hunter/.test(publisher)) return publisher;
  const host = publisherHost(url);
  return (host && CANONICAL_PUBLISHERS[host]) || publisher || null;
}

module.exports = { CANONICAL_PUBLISHERS, canonicalPublisher, publisherHost };
