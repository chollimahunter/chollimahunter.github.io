# GitHub email owners

`scripts/gh-email-owners.js` asks GitHub which account holds each indexed
email address. GitHub attributes a commit to an account (the `author` object
the API returns beside the raw author name and address) only when the
commit's author address is one of that account's verified addresses, and the
attribution follows the account through a rename. One commit search per
address therefore names the account that controls it today, whoever made the
commit: a persona's own account under a name the index has never seen, or an
indexed account that has since been renamed.

```
node scripts/gh-email-owners.js collect [--limit N] [--force]
node scripts/gh-email-owners.js rank [--all]
```

`collect` reads every indexed `email_address` record and the DTEX bulk list in
`itworker-datasets.json`. It leaves out records whose campaigns are all ones
where a listed address is a spoofed sender or an affected owner rather than an
operator: Kimsuky, APT37, Konni, APT38, Andariel and PolinRider. A noreply
address of the form `<id>+<login>@users.noreply.github.com` is settled without
a search: the numeric id is the account's immutable id, and `user/<id>`
returns its current login, so a different login there is a rename as a matter
of how the address is constructed. These go first. Every other address costs
one commit search, spaced for the search API's 30 a minute, so a full pass of
about 5,400 addresses takes about three hours. Results go to
`_drafts/private/gh-email-owners.json`, rewritten after every address so a
stopped run resumes.

`rank` groups the owning accounts the index does not hold as a
`github_profile` or `username`, with the addresses behind each, their
campaigns, and any former handle a noreply address shows. `--all` lists the
indexed ones too. An address also tagged PolinRider is left out of the
ranking, because its holder is as often an affected repository's owner as an
operator.

GitHub's commit search enforces a tighter short-term limit than the
documented 30 a minute, and a 403 costs a 60-second wait; set
`GH_SEARCH_GAP_MS=4000` (also read by `gh-renames.js`) when another search
pivot is running at the same time.

Used the other way round, the sweep is also a false-positive check: an
indexed address held by an established account (years old, a named employer,
a long commit history outside any persona's repositories) may belong to an
uninvolved person whose address or old handle a list picked up. On 22
November 2026 the first such case went to the held-for-decision list.

An owner is a strong signal and still not a finding. A published list can
carry a victim's address, an address an operator borrowed from a real person,
or a mistranscription, and the account holding it is then that person's. Read
the account before treating it as anything: its creation date, what it
commits and where, and whether the address sits among other listed values.
Results stay in the private repository and are filed only on their own
evidence.
