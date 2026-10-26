# What the DPRK-linked GitHub accounts have in common

## What this is

The dossiers in this repository hold 238 GitHub accounts, reached one at a time
over many passes. This note asks a different question: measured together, what do
they share that ordinary developer accounts do not? It records a measurement run
on 20 September 2026 against the commit-metadata walk of 19 September, which
captured every non-fork repository of those accounts along with its creation
date, its last push, its commit count and its full author-line tally.

Nothing here is publishable as an indicator. A resemblance between two accounts
is a lead, not a value, and this site's merge rule still requires a shared value
before two records join. The output is a description of a population.

## The control, and why the whole exercise depends on it

A feature that is just as common among ordinary developers is a description of
GitHub rather than a finding, so every measure below is reported against a
control. The control is the 689 live GitHub logins that committed into the held
accounts' repositories without being held accounts themselves: in the main, the
original authors of code that was copied in. They are a convenient comparison
group because they were collected by the same process rather than chosen to prove
a point, and because 458 of them predate 2021, which no held account population
can be accused of matching by construction.

The control is not clean. Some of those 689 will be further accounts of the same
operations that no pass has yet identified, which pulls the control toward the
subject and makes every lift reported here a conservative one. Where a measure
depends on how long a repository has existed, the comparison is stratified by the
year the repository was created, because a repository made in 2015 has had ten
years in which somebody might push to it.

Two caveats attach to the population itself. These 238 accounts were not sampled;
they are the accounts that reporting, scraping and manual pivots happened to
surface, so any trait that makes an account easier to find is over-represented
here. And 85 of the 238 are now gone, against 5.9 per cent of the control, which
looks like a finding until one remembers that being indexed here is downstream of
being reported, and being reported is upstream of being suspended. That number
measures the consequence of exposure, not a shared habit.

## What actually separates them

The strongest single measure is not about any one repository but about the shape
of an account's whole public presence. **A quarter of the held accounts made half
or more of their repositories on a single day, against 3.4 per cent of the
control** — a seven-fold difference, and the clearest statement in the data that
these are presences assembled to be looked at rather than accumulated by working.
On the most concentrated, the entire account is one afternoon: `jacksonmori755`
created 30 of its 31 repositories on one day, `generalxdev` 27 of 31,
`Guangyang-Sunlight` 35 of 52.

Close behind it is the handle. **17 per cent of held accounts carry both a job
word and a numeric suffix — `smartdev914`, `devking0718`, `top-dev-999` — against
2.5 per cent of the control, a 6.9-fold difference.** Each half of that is
separately elevated: a job word anywhere in the handle runs at 3.8 times the
control rate, a suffix of four or more digits at 3.1 times. The particular shape
of the digits matters too: 17 per cent of held handles end in something that
parses as a month and a day, against 4.4 per cent of the control.

The highest-precision signal in the whole set is the one already found by hand and
never measured. **Where a handle ends in three or more digits, those same digits
recur in an address the account commits under in 37 of the 153 live held
accounts.** `ruijindev0801` commits as `ruijin.developer0801@outlook.com` and also
as `expertbot0801@gmail.com`; `starmastar1126` reaches across four addresses and
three further handles all carrying 1126. This is a within-account link rather than
a between-account one, which is exactly why it is useful: it joins an address to a
persona without naming anyone new, and `docs/handle-pivot.md` already treats it as
the channel it is.

Finally, the accounts do not sustain anything. Restricting both populations to
accounts with at least three repositories old enough for the question to be
answerable, **38 per cent of held accounts have a single repository that stayed
alive longer than a year, against 74 per cent of the control**, and 21 per cent
have nothing that ever lived past thirty days, against 7.8 per cent. On the median
held account, 11 per cent of its repositories were touched more than a month after
being created; on the median control account, 29 per cent were.

## What does not separate them, which is worth as much

The raw repository figures look far more dramatic than they are, and the
correction is the most useful thing this pass produced. Across the held set, 64
per cent of repositories were last pushed within an hour of creation and the
median repository lived six minutes. Read alone, that is damning. Read against a
year-matched control it is ordinary: the control sits at 28 to 47 per cent
depending on the year, for a lift between 1.4 and 1.7. Tightening the threshold
makes it worse rather than better — **at one minute the lift collapses to 1.0,
with the held accounts indistinguishable from everyone else** — because pushing a
finished local repository in one go is simply how a great many people use GitHub.
The separation lives in the upper tail, in work returned to, not in the speed of
the first push.

Bios do not separate them either. Held accounts are slightly *more* likely to
write one than the control, and the phrases they share are the vertical rather
than the operation: "full stack blockchain developer" is the most common shared
phrase inside the held set and it appears in the control too. Of the nine
four-word phrases shared by two or more held accounts, only seven are absent from
the control, and most are the ordinary furniture of a developer bio. The one real
hit is a pair: `CleverSofter` and `Ideal-Softer` both carry the same unusual
line about a thing being more precious than gold, and their handles are the same
construction.

That pair is worth more as a check on the method than as a lead, because the
index already holds both accounts in the same group — the Saja network portfolio
accounts recorded from the Nisos reporting, whose commit histories were walked on
20 September 2026. A text comparison run with no knowledge of that grouping
recovered it from two bio lines. It is a single case and proves nothing on its
own, but it is the only opportunity in this data to see the phrasing channel tested
against an answer that was already known, and it produced the right one.

An empty profile is likewise weaker than expected. Absent location is genuinely
elevated at 1.6 times the control, but a blank bio, blank company, no followers
and no accounts followed all sit between 0.8 and 1.4, which is too close to
ordinary to carry weight on its own.

Shared repository *names* are a clean null, and the way they fail is instructive
enough to record so nobody runs it twice. The idea is reasonable: accounts
working from one playbook might create repositories called the same things. They
do not, or at least no more than anyone else. Counting pairs of accounts that
share three or more distinctive repository names at a Jaccard of 0.15 or better,
after discarding the names everybody has, the held set produces one pair in 7,626
and the control produces sixteen in 126,253 — the same rate to three decimal
places, 0.013 per cent on both sides. The single held pair, `eros1006` and
`VeteranSoftDev`, is already grouped under the Saja network portfolio accounts, so
it is one more recovery rather than a lead.

The control's sixteen pairs are the useful half. Every one of them is a student:
118 repositories across ten control accounts are named for ALX software
engineering assignments, `alx-backend-user-data`, `alx-system-engineering-devops`
and the rest, so a cohort working the same syllabus looks exactly like a cell
working the same playbook. Read without a control, "sixteen accounts share
repository names" is a finding. Read with one, it is a bootcamp.

## Profile READMEs, and the two corrections the measure needed

The resemblance noticed by hand in an earlier pass was between two profile
READMEs, so the second run of 20 September fetched the `{login}/{login}` README
for every account on both sides that had one: 69 of the 153 live held accounts
against 201 of the 689 control accounts. Having one at all is mildly elevated,
1.5 times the control rate, and means little on its own.

The comparison needed two corrections before it said anything true, and the first
ranking produced by skipping them was wrong in both directions — it invented
clusters that do not exist and it still missed nothing, which is the worst kind
of wrong because it looks like a result.

**GitHub seeds a new profile repository with a template.** An account that
creates one and never edits it keeps the "Hi there" text and its commented block
of suggestions verbatim. Seven control accounts and two held accounts matched
each other at a similarity of 1.000 on that boilerplate alone, which put a
perfect and meaningless match at the top.

**A README generator's output is scaffolding, not writing.** This one is subtler
and it survived the first correction. Several accounts on both sides use a
profile-README generator whose "Languages and Tools" block is a single enormous
line of `<img>` tags, one per technology. Strip the URLs out of that, as a naive
normaliser does, and what remains is a long repetitive run of link attributes and
tool names: `elegant-idn` and `dluoulb` both reduced to about 1,240 words of
which exactly 160 were the placeholder token for a URL. They scored 0.882 against
each other on HTML furniture. `kryptify` joined them at 0.53 on the strength of a
single shared line, `<h3 align="left">Languages and Tools:</h3>`. None of that is
a shared template; it is three people clicking the same generator, and the phrase
appears on 12 held and 13 control READMEs, which is the same rate.

The fix is to compare visible prose only — drop HTML tags, markdown image and
link syntax, code fences and the seeded comment, and require at least forty words
of what is left. That leaves 49 held and 108 control READMEs, and it is the only
version of this measure worth quoting.

### What the corrected measure says

**Not one of the 5,778 control pairs reaches a similarity of 0.3. Six held pairs
do, and 14 per cent of held accounts have a near-duplicate of their profile
README prose on another held account.** The background rate is zero, and the
generator correction did not weaken that — it strengthened it, by removing the
two clusters that were scaffolding and leaving only pairs that share written
sentences.

Every surviving cluster is one the index already held:

- `websparkledev`, `VeteranSoftDev` and `nulidev`, between 0.96 and 0.99, all
  already in the Saja network portfolio group.
- `ruijindev0801` and `devstar9981` at 0.855, both already under Rui Jin.
- `adam912913` and `tysonstar912913` at 0.804, dealt with below.
- `AMagicHarry` and `Magic-Glove` at 0.417, already in one unattributed group,
  and sharing two addresses — including
  `155698908+amagicharry@users.noreply.github.com`, which carries AMagicHarry's
  own numeric GitHub user id, so `Magic-Glove` commits as AMagicHarry's account.

Four clusters, four recoveries, no false positives and no new leads. That is a
validation rather than a discovery, and it is the honest outcome: the measure
works, and on this set there was nothing left for it to find.

### The two leads reported from the uncorrected run are withdrawn

An earlier version of this note offered `solutionGuru0129` (Tiger) against
`itdream-dev` (Arkaan), and `kryptify` against the `mr.new0509` group, as leads.
Both were artefacts and both are now explained.

`kryptify`, `elegant-idn` and `dluoulb` are the generator case above. The Tiger
and Arkaan pairing is a circulating template: the two READMEs share 57 identical
lines, including a link to POAP token 6673781, which appears in only two of the
270 READMEs fetched here and looks decisive until it is searched for properly.
GitHub code search finds the same block on `jdg2896`, a Philippines developer
since 2019 with a real blog who is almost certainly its author, and on
`AlfatTaufik`, who has nothing to do with any of this. Two accounts carrying it
have touched the same popular text, which is all it establishes. On visible prose
the pair falls below 0.3 and the corrected measure rejects it unaided.

**The discipline this implies is a code search before any README match is called
a link.** A match inside a closed comparison set says the text is rare in that
set, not that it is rare. The test is whether the text has a third-party origin,
and it costs one query.

### Two accounts that look right and link to nothing

Running that code search turned up two accounts not in this index, both of which
match the held population on every shape measure in this note and neither of
which shares a single value with it.

`webmaster1225` was created in August 2024, gives its profile name as "Full Stack
Developer", sets no bio, location or blog, and holds 56 repositories. Its commits
run overwhelmingly on `hardysmith940110@gmail.com` under four display names —
Hardy Smith, webmaster1225, Hardy, and Full Stack Developer — with
`itisluckyman@gmail.com` and `groupofstars36145@gmail.com` beside it.
`cyclone-pro` was created in February 2026, holds 46 repositories, sets no bio or
location, and runs on `tanaka.kaito.901@outlook.com` under five display names
including Sleepy Fox. A second address on it, `mei.wei.0422@gmail.com`, echoes
the handle `meiwei0422` in the way `docs/handle-pivot.md` describes.

Neither shares an address, a collaborating login or any other value with the 238
walked accounts or with anything in this index. They are recorded here as
candidates and nowhere else, because shape is not evidence and a README that
circulates is not a link. Their only connection to this set is a template written
by somebody else.

### One pair that is not merely a lead

`adam912913` and `tysonstar912913` are held as two personas and are one holder.
The profile README is the weakest of three independent reasons to think so.

The commit ledger is decisive. Both accounts' repositories carry commits from the
same two author lines: `tysonstar912913 <tyson.star.912913@gmail.com>`, 41 times
on `adam912913` and 88 on `tysonstar912913`, and `adam719912
<tyson.star.912.913@gmail.com>`, 13 and 7 times respectively. Those two addresses
differ only in the placement of a full stop, and Gmail ignores full stops, so
`scripts/lib/ioc-normalize.js` already collapses both to
`tysonstar912913@gmail.com`. The site's own normaliser says these are one
mailbox, which satisfies the shared-value requirement without any argument from
resemblance.

Third, the profile README of `adam912913` still carries GitHub's boilerplate
naming `**tysonstar912913/tysonstar912913**` — the template embeds the owner's
own login, so a mismatch records which account the file was copied from. Across
both populations this artefact appears rarely but reads cleanly when it does: of
the 28 control READMEs carrying the marker, one names a different account, and it
is an account that had simply been renamed. `jimmynet444` carries the same
artefact naming `201206030`, but that is a long-established developer in Hubei
with 380 followers and no connection to any of this, so it records a README
lifted from an uninvolved person rather than a link between operators. The
distinction matters and the artefact does not make it on its own.

`adam719912` is not a GitHub account; it exists only as a name configured in a
git client.

## The follow graph, and the one account it produced

The two candidates above share no value with this index, so the next question was
whether they connect to it socially. Both were checked against the follow lists of
the 238 walked accounts, and a background rate was measured by sampling 70 control
accounts the same way.

**Seven per cent of control accounts already follow, or are followed by, a held
account**, so a single follow edge is nearly worthless on its own. `webmaster1225`
has none at all and remains a candidate resting on nothing but shape.
`cyclone-pro` mutually follows `ruijindev0801`, which is suggestive beside the Rui
Jin README template it carries, but a mutual follow is a relationship rather than
a value and it does not meet the merge rule.

The useful result came out of the control sample instead. `SrDev36428` turned up
in it following eight held accounts at once — `eros1006`, `TopRatedDev36428`,
`GoodWork0903`, `Talented0Dev`, `nulidev`, `CleverSofter`, `SoftwarePassioner` and
`blockbusterdev`, seven of which sit in the Saja network portfolio group. It gives
its location as World, its profile name as a list of stacks, and it was created on
24 January 2024, four weeks after `TopRatedDev36428`, whose handle it echoes digit
for digit.

Walking it settles what it is. **`SrDev36428` is GitHub account id 157616488, and
it used to be called `DevsWorld36428`** — the old handle now returns 404, and the
account commits under both `157616488+SrDev36428@users.noreply.github.com` and
`157616488+DevsWorld36428@users.noreply.github.com`. GitHub mints those addresses
from the immutable numeric id, so they are one account under two names, and that
is not an inference.

That noreply address is already in the commit ledger of two held accounts:
`eros1006` carries three commits from it and `TopRatedDev36428` one, both under
the display name Beautiful Devsworld. A third held account, `blockbusterdev`,
carries 544 commits from `beautifuldevsworld@gmail.com` under the names
softvoyager, DenysOstroverkh and TalentedDev36428, and `TopRatedDev36428` carries
that same address under the name DevsWorld36428. All three are in the Saja network
portfolio group.

So an account this index does not hold has committed into the repositories of
three accounts it does, under names carrying the group's own numeric suffix, while
following eight of its members. None of the addresses involved is published here
today; they exist only in the commit ledger, which lives outside this repository.
Whether `github.com/SrDev36428` should be added to that group is a publication
decision rather than a measurement, and it is recorded here first.

The honest limit on it: the direct evidence from account 157616488 into held
repositories is four commits. The weight comes from the combination — the shared
suffix, the creation date four weeks apart, the eightfold follow overlap and the
rename — rather than from the commit count, and a reader should be told so.

It also means the control is contaminated in the way this note warned it would be.
`SrDev36428` was sampled as an ordinary developer and is nothing of the kind, so
every lift reported above is a conservative one.

## Where this leaves the method

Three of these measures are cheap enough to run against any new account before a
human spends time on it: how much of the account was made on one day, whether the
handle pairs a job word with digits, and whether those digits recur in an address
it commits under. None of them is evidence by itself and none belongs in the
index, but together they rank a list, and ranking is what a pass over several
hundred candidate accounts actually needs.

The profile README comparison is a different kind of tool and deserves to be run
as a matter of course on every account added from here. It is one API call per
account and its background rate in the control is zero. On this set it recovered
four known groupings and proposed nothing, which is the result a validated
measure gives when there is nothing left to find.

It needs three things, and skipping any of them produces confident nonsense.
Strip GitHub's seeded boilerplate. Compare visible prose rather than raw text, or
a README generator's icon wall will manufacture clusters out of HTML. And search
GitHub for the matched text before calling a match a link, because rarity inside
a closed comparison set is not rarity: `jimmynet444` copying a Hubei developer's
README, and the Tiger and Arkaan pairing tracing back to a Philippines
developer's template, are the two standing reminders that a shared file says two
accounts touched the same text.

The `adam912913` and `tysonstar912913` finding has been acted on, and what it
needed turned out not to be a merge. The site was already carrying the
connection: the normalizer in `scripts/lib/ioc-normalize.js` collapses
`tyson.star.912.913@gmail.com` and `tyson.star.912913@gmail.com` to one value, so
the indicator page for that mailbox has been linking both persona pages all
along. What was missing was that neither persona said so, leaving a reader to
discover it by opening the address and noticing two names. Both entries now state
it and give the commit evidence. They are not merged, because each is the record
of a different researcher post and collapsing them would destroy the provenance
of two captures in order to express something the shared indicator already
expresses.

Both leads this pass originally reported are withdrawn rather than outstanding.
The Tiger and Arkaan pairing is a circulating template and `kryptify` against the
`mr.new0509` group is generator scaffolding; the corrected measure rejects both
without being told to. What is left instead is two accounts, `webmaster1225` and
`cyclone-pro`, that match this population on every shape measure here and share
no value with it. They are candidates for a future pass and nothing more.

## Reproducing this

The ledgers and runners live in `~/Downloads/github-commit-walk/`, outside this
repository, because they carry the full author-line tally of every walked
repository. `similarity.js` produces the profile, handle and bio comparisons;
`control-repos.js` fetches the control's repository metadata through `gh api`;
`repo-shape.js` produces the year-stratified repository comparison; and
`readme-fetch.js` with `readme-shape.js` produce the profile README comparison.
All are keyed so a rerun resumes rather than re-asks.

Every fetch goes through `gh api` rather than a token read into the environment,
which is both simpler and the only thing the session is permitted to do.

One artefact is worth knowing about: the ledger holds an author line for
`tech-master823` containing raw terminal escape sequences, where an operator
corrected a `git config user.email` with arrow keys and the escapes were written
into the commit metadata. It is a curiosity rather than an indicator, but any code
reading these author lines should expect control characters in them.

## Postscript: the numeric id in a noreply address

The `SrDev36428` find came from a property of GitHub worth stating on its own,
because it is the only channel in this whole exercise that yields proof rather
than resemblance. A commit made with GitHub's private-email setting carries an
address of the form `id+handle@users.noreply.github.com`, and the numeric part is
the account's immutable id. The handle beside it is whatever the account was
called at the time of the commit. Two different handles on one id are therefore
one account renamed, as a matter of how the address is constructed, and
`gh api users/<id>` returns whatever that account is called now.

Swept across the whole ledger, 374 noreply addresses resolve to 309 distinct
accounts, of which **32 carry more than one handle and so have been renamed at
least once, yielding 51 former names**. Every one of the 32 ids resolves to an
account this index already holds, so the sweep named no new account — but it did
correct an overcount. Seven of those former handles were already published here
as separate `github_profile` indicators, recorded before the rename was known,
so the index was presenting up to fourteen profiles where there are six
accounts. `erosyj` alone had been filed twice more, as `xfika` and
`greengarden510`.

Two of the abandoned handles have since been re-registered by unrelated accounts
under different numeric ids: `yamamotojiro`, formerly `DreamHigh0806`, and
`fancydeveloper`, formerly `BitFancy`. Neither is published as a value, and the
general rule that follows is worth more than the two cases. **A former handle is
recorded as a `username`, never as a profile URL.** An unregistered handle can be
taken by anyone at any time, and a published URL would then point at a stranger.
The value is a string that belongs to a moment in the past; the URL is a claim
about who someone is now.

## Ranking the control, and the trap inside it

If an operation account was sitting in the control, others may be. All 504
control accounts with three or more repositories were scored on the measures
that actually separated the two populations — the share of the account made on
its busiest day, a handle pairing a job word with digits, no repository alive
past thirty days, an absent location, and a numeric suffix matching a held
account's. Nineteen score six or higher out of a possible eleven.

The ranking can be tested, because `SrDev36428` is in it and is known. It comes
second. That is one case and not a validation, but a scorer that buries the one
account already proven to belong would not be worth running.

**The trap is that every account in this control commits into a held
repository**, because that is how the control was collected. Nineteen accounts
all showing "commits into a held account" is therefore not nineteen findings; it
is the selection criterion restated. The question each candidate has to answer is
the one this index already asks of a recovered address: does it commit under a
name the held account uses of itself, which is a holder's second identity, or
under its own name, which is what the upstream author of a copied repository
looks like?

One account passes. `starmaster1126`, id 52027648, authored 50 commits in
`starmastar1126`'s repositories signed Silas Jo, and the held account's own
former-handle noreply address signs two commits there with the same name. The
handles differ by one letter and the profile names — StarMaster DevGenius against
StarMastar DevGenius — differ by the same letter. It is filed.

`dylanwilliams1126` is the instructive failure. Its address is already in the
held account's commit history and its handle carries the same 1126 suffix, which
is two of the signals this note treats as strong. It commits once, under its own
name. One commit under an unshared name is an ordinary contributor, so it is not
filed, and the reasoning is published on the page beside the account that was.

The honest summary of the pass: seventeen of the nineteen are ranked by shape and
nothing else, and shape has never been evidence here. The ranking earns its place
by deciding who is worth a commit walk, not by deciding anything at all.

## Shared display names, the last channel worth sweeping

`starmaster1126` was found because one distinctive name, Silas Jo, was worn by
two GitHub accounts, so the ledger was swept for the general case: which commit
display names belong to more than one identity? Bot accounts and the placeholder
a fresh git install leaves behind are discarded, and an identity is taken to be a
numeric GitHub id where the noreply address carries one and the address itself
otherwise.

**Five names are worn by two or more distinct GitHub account ids.** Silas Jo is
one, which is the sweep recovering what prompted it. Alex, across two ids, is too
common to mean anything and one of those ids is deleted. The remaining three all
sit inside the Saja network portfolio group and every id behind them resolves to
an account the index already holds: Jan Kowalski signs from four, Jiners Enoheart
from three, Leon Hoffmann from two.

So the channel produced no new account. What it produced instead was the answer
to a question the index had already written down and left open. The Nisos entry
records that the report named Jan Kowalski and four others but tied none of them
to a particular account, so none was recorded. Six names are now tied: three read
from the accounts' own GitHub profile name fields, and three from commit
signatures crossing several ids.

The detail worth keeping is what the names are. Marcin Pawlak on `CleverSofter`,
Damian Kowalczyk on `SoftwarePassioner`, Taylor Fuller on `Ideal-Softer`, and Jan
Kowalski signing commits from four accounts at once — which is the standard
Polish placeholder name, the John Doe of Warsaw. A network that Nisos assessed as
posing as Polish and United States developers turns out, read at the commit
level, to be signing its work Jan Kowalski. Only Jiners Enoheart is distinctive
enough that a search on it would mean much, and the entry says so rather than
letting six alias records imply six leads.

## Repository provenance

A second pass, on 20 and 21 September 2026, asked a narrower question of the
same 238 accounts: not whether two profiles resemble each other, but whether a
repository's own history says it was copied. `provenance.js` walked 1,116
repositories flagged across the held accounts and marked each `imported` (a
first commit dated more than a day before the repository itself was created),
`rewritten` (a first commit dated before the account existed, signed with the
account's own identity), or `impossible-domain`. The rule for calling a copy
backdated is that its first commit must predate the *origin* repository's
first commit, not merely the copy's own creation date, and that origin-dates
comparison was never run. None of the three flags is therefore a finding on
its own; they mark candidates for the channel that did produce one.

That channel was origin ownership. For each flagged repository, the pass
identified a candidate origin — a non-held account's repository overlapping
the flagged one at a Jaccard of 0.8 or better and carrying five stars or
fewer, the same "convenient rather than famous" filter the rest of this note
relies on for its control — which produced 216 candidate owners. Their commit
histories were walked through GitHub's GraphQL API: 146 of the 216 were
walked, and 51 of the 197 targets attempted returned no commit record at all,
typically a deleted or emptied account.

The rule that made the walk mean something is an ownership test, not a
presence test. An address counts as an account's own only when it signs the
bulk of that account's commits, or when the account's login or a former
handle — recovered, as elsewhere in this note, from
`<id>+<login>@users.noreply.github.com` on the account's own commits — appears
as the commit author name. An address that merely turns up inside a
repository a held account copied belongs to the upstream operator whose code
was taken, not to the holder; the distinction this note draws throughout
between a shared file and a shared value applies here unchanged.

Run against the index's own addresses and profile names, the walk filed eight
accounts on 21 September 2026, in commit `bb34f33`, two of them tied to
personas already held. `darkmandev103` is the lazarus.group registry's
`diamondyhand` under a renamed handle, its own commits signing the address the
registry gives for Kevin Tan. `everythinguwannatobe`, with
`spencerduncanpower@gmail.com` beside it, signs the address the ZEUS-DEV-919
document gives for Spencer Duncan. Six more addresses came off The Raven
File's and tayvano's lists with no account previously attached and are filed
together as an unattributed group: `revoltig4sg` (formerly `codemaster05330`),
`dybbuk-dev` (formerly `dybbuk555`), `prowebdev119`, `Typhon0130` with
`swan1213` registered to its address, and `luckylightcodes` (formerly
`nicolas-north`, also signing as `jupiter.softdev`).

Several candidates the same walk reached are recorded only as leads, for want
of an address that is the account's own rather than an upstream operator's:
`loveFeynman`, whose 19 repositories duplicate `jacksonmori755` and whose own
address, `wando0226@gmail.com`, also commits on another persona's repository
under a mutual follow; `kingpig-dev` and `ranupthestairs`, which share
`rowelyle9@gmail.com` and hold commits from `juliegibbs206`; `Alpa8820`,
`rhaylee250` and `codekami45`; `Iaminblockchain`, whose address is
`secretsuperstardev@gmail.com`; `emali01`; `crazy0629`; and the
`jacksonmori755` and `solutionGuru0129` fleets, whose accounts share whole
portfolios of repositories with each other but no address yet, which a
second-order walk of their own origin owners would be needed to reach.

The highest-overlap shared repositories outside these leads were mostly not
evidence of anything: public projects such as three.js, PancakeSwap, SushiSwap
and vben, or one persona's own two accounts. Assistmind, recorded elsewhere in
this index as client code shared across nine developer accounts, is the
clearest instance of the pattern this whole channel exists to filter out — a
repository held in common is a repository handed to more than one hand, and
only an address makes it a link.

The working files for this pass — `provenance.json`, `origin-owners.json` and
the GraphQL walk's output — were kept outside this repository, in a temporary
folder since deleted, and cannot be rerun. This section is written from the
commit record and the analyst's own notes rather than from a file that
survives.
