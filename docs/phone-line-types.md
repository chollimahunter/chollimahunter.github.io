# Tool: phone line-type lookups

## Purpose

A telephone number on a CV is ten digits and an area code the operator chose.
What makes it evidence is the kind of line behind it. A persona claiming a
decade of employment in Texas, reachable on a Skype number bought online, is a
different proposition from one reachable on a carrier mobile — and a number in a
block no carrier holds is not a number at all.

`scripts/data/phone-lookups.json` holds what was found for each telephone
indicator. `scripts/lib/dossiers.js` reads it at build time and attaches a
`phone_status` block to the record; `src/_includes/partials/ioc-detail.njk`
renders it under "Line type" wherever that indicator appears. Nothing is
inferred: a number with no entry renders with no line-type block at all, because
"not looked up" and "unknown line type" are different claims.

## What the third pass found, 2026-09-30

The index had grown to 116 telephone indicators, 72 of them with no entry,
most from the pipu.cc CV listings. All 72 were looked up through the API in one
ledgered run, so all 116 now rest on a per-number answer.

- **46 are VoIP.** Skype again leads with 30 (24 Skype Communications, 6 Skype
  P2P), then Sinch 7, Google Voice 5, Bandwidth 3 and Twilio 1. Sinch answers
  VoIP for most of its numbers and wireless for three.
- **17 are wireless.** Twelve are US numbers on T-Mobile, Verizon, AT&T and
  Sinch; five are outside the US (Alands Mobiltelefon twice, Smart
  Communications, Orange Romania, Lifecell).
- **8 are landlines**, including two on AffinityClick-Inteliquent and single
  numbers in Ireland, Japan, Poland and Finland.
- **1 is not assigned.** `+3580441576` is rejected as invalid. The CV behind it
  prints `+358 044 1576`, which keeps the domestic trunk 0 after the country
  code and is too short for a Finnish number.

## What the second pass found, 2026-09-13

All 44 telephone indicators now rest on a per-number lookup. The remaining 31 —
24 that had only block data and the 7 that had no entry at all, including every
non-US number — were resolved through the phonevalidator API rather than the web
form, which removes the rate limit the first pass had to work around. Every
`basis` in the file now reads `number`.

- **33 are VoIP.** Skype accounts for 23 of them (16 Skype Communications, 7
  Skype P2P), Bandwidth for 6, Google Voice for 4. Nothing here is a line
  somebody had installed at an address.
- **5 are wireless**, and four of those are the non-US numbers: Polkomtel in
  Poland, CAT Telecom in Thailand, NTT Docomo in Japan, China Unicom in China.
  The fifth is a US number on Sinch, a communications-platform provider selling
  programmable numbers to software rather than handsets to people.
- **1 is a landline**, on Iristel, a Canadian competitive local exchange carrier
  whose numbering is widely resold.
- **5 are not assigned to anything.** The three the first pass found from block
  data are confirmed against the number itself, and two more join them: the
  malformed `+1753362648`, whose area code 175 does not exist, and
  `+6542982608`, which the lookup rejects outright.

**The one worth reading twice: `+8618642583550` is a China Unicom mobile number
registered in Dandong, Liaoning.** Dandong is the Chinese border city facing
Sinuiju, and the crossing through which most DPRK cross-border traffic moves. The
field records where the number is registered, not where a handset was, and the
site claims nothing further from it — but of the 44 numbers this dataset holds,
it is the only one whose registration sits on that border.

The per-number answers also confirm what the first pass suspected about porting:
of the 24 numbers that previously carried only block data, most name a carrier
different from the one holding the block, and the block carrier is kept beside
the per-number one in `block_carrier` wherever both were established.

`names` is still empty on every entry. The API sells line type, not reverse
lookup, and the consumer services that do return names still gate behind a human.

## Using the API

    https://api.phonevalidator.com/api/v4/phonesearch?apikey=KEY&phone=NUMBER&type=basic&region=1

GET, JSON back. `region=1` searches inside and outside the US, which is the right
setting for this dataset: `region=2` would mark every non-US number fake and
`region=3` would do the same to the US ones. A `basic` lookup returns `PhoneBasic` with `LineType`, `PhoneCompany`, `PhoneLocation`, `Country`,
`FakeNumber` and `FakeNumberReason`. `StatusCode` `200` is a good answer; 501 is a
bad number format, 503 a bad key, 504 an empty account.

**A lookup costs money, so no number is ever looked up twice.** The runner used
for this pass keeps a ledger keyed on the E.164 value, writes the slot BEFORE the
request goes out so a crash still records the spend, and refuses any number
already in it. Keep the key out of the repository: pass it through the
environment.

## What the first pass found, 2026-09-12

Thirty-seven of the 44 telephone indicators now carry an entry — 13 from a
per-number lookup and 24 from the block the number sits in. Of those:

- **29 are VoIP**, and the carriers are the wholesale names that sell numbers
  online with no address and no identity check: Skype on eight of them (seven
  Skype Communications, one Skype P2P), Bandwidth on twelve, plus Level 3, Onvoy,
  Telnyx and one Google Voice number.
- **2 are wireless**, on Verizon and AT&T blocks.
- **1 is a traditional landline**, on a Southwestern Bell block.
- **3 are not assigned to any carrier at all.** 222-284-1219 and 222-854-4879 sit
  in blocks nobody holds, and 413-113-1213 has an exchange code beginning with a
  1, which the North American numbering plan does not allow — it cannot be
  dialled. A per-number lookup returns no record for any of the three. The
  registry that published the last one already marked it fabricated; the other
  two it did not.
- 2 are CLEC blocks whose line type cannot be called from the carrier name
  (PAETEC ITEL, MCImetro).

Porting is why the per-number lookups matter and why the two bases are kept
apart. 973-259-6343 sits in a Verizon New Jersey block and is a Bandwidth VoIP
line; 321-280-6782 sits in a MetroPCS block and answers to Skype. Seven of the
thirteen per-number answers name a different carrier from the one holding the
block.

The five non-US numbers and the malformed `+1753362648` had no entry at this
point; the second pass above resolved all six.

## Where the data comes from, and the two kinds of claim

**phonevalidator.com** answers for the line itself, so it reflects porting: it
named Skype as the carrier of 832-706-3757, a number inside a block assigned to
Bandwidth. That is the better answer, and records built from it carry
`"basis": "number"`.

The web form is also rate-limited, and it hides the fact: past the limit every search
returns "SERVICE UNAVAILABLE — Either we're doing updates or you might be running
too many searches" inside a normal-looking results page rather than as an error.
Roughly ten to twelve lookups run before the wall comes down, and it lifts again
after about half an hour.

The form is worth knowing about too. Four of its five telephone inputs are
honeypots positioned off-screen at `left: -9616px`, and the one a person actually
types into is named `rebmuNeliboM` — "MobileNumber" reversed. Filling the first
`input[type=tel]` submits an empty search. From a loaded tab, the whole form can
be posted same-origin, which is what the second pass used:

```js
const form = document.querySelector('form');
const body = new URLSearchParams();
for (const el of form.querySelectorAll('input, select, textarea')) {
  if (el.name && el.type !== 'submit') body.append(el.name, el.value || '');
}
const tel = [...form.querySelectorAll('input[type=tel]')]
  .find((e) => e.getBoundingClientRect().left > 0);
body.set(tel.name, '973-259-6343');
```

The hidden `FormToken` has to come from a page the browser actually loaded, so
this works from the site's own tab and not from a bare fetch.

**localcallingguide.com** answers for the thousand-block from LERG data, is not
rate-limited, and is fetchable without a browser:

    https://localcallingguide.com/lca_prefix.php?npa=832&nxx=706&x=0&y=0

It gives the OCN, the carrier the block is assigned to, and the rate centre. A
number ported away from that carrier still shows the block's owner, so records
built from it carry `"basis": "block"` and the page says so in as many words.
Every remaining number was resolved this way, one fetch per NPA-NXX.

Where both answered, both are kept: `carrier` is the per-number answer and
`block_carrier` the block's owner.

One quirk worth knowing: phonevalidator labels a Skype line "LANDLINE" while
naming Skype as the carrier in the same row. The classification here follows the
carrier, and the entry's `note` says that the two disagreed.

## The fields

```json
{
  "value": "+18327063757",
  "checked": "2026-09-12",
  "line_type": "VoIP",
  "carrier": "SKYPE COMMUNICATIONS",
  "block_carrier": "BANDWIDTH.COM CLEC, LLC - TX",
  "basis": "number",
  "location": "HOUSTON, TX",
  "ocn": "004F",
  "sources": ["phonevalidator.com", "localcallingguide.com"],
  "names": [],
  "note": "..."
}
```

`value` must be the E.164 form the index stores — the entry is matched on it
exactly. Every other field is optional and absent rather than null where it was
not established. `ocn` is recorded here as localcallingguide.com states it, but
`phoneLineStatus()` in `scripts/lib/dossiers.js` does not copy it through, so it
is never carried onto a page.

`names` is for a reverse lookup that returns a name against the line. It is
deliberately empty so far: spydialer.com and the PeopleFinders link phonevalidator
sends you to both require a human through a consent flow, and neither was run.
When one is, put the names there and nothing else — the page labels them as a
directory association, not an identification, because in this dataset a name
against a number is as likely to belong to the real person whose identity a CV
was built on as to whoever used it.

## Running it again

There is no script. A number is looked up by hand at phonevalidator.com, or by
fetching the Local Calling Guide URL above, and the result is written into
`scripts/data/phone-lookups.json`. The build does the rest. Keep `checked`
current on each entry you touch, and leave the ones you did not alone.
