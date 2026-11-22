# GitHub renames

`scripts/gh-renames.js` checks whether indexed GitHub accounts recorded as
removed were only renamed. A deleted account's commits lose their
attribution; a renamed one's keep it, under the new name. On 22 November 2026
the listed account newstable, by then answering 404, turned out to be the
same account id under a fourth handle.

```
node scripts/gh-renames.js collect [--limit N] [--force]
node scripts/gh-renames.js rank
```

`collect` takes every `github_profile` whose `account_status.state` is
`removed` and runs one commit search by author name for the handle, spaced for
the search API's 30 a minute (about 30 minutes for the 800 or so removed
accounts). Of the commits whose author name is exactly the handle, it records
the account each is attributed to and the id of any noreply address carrying
the handle, resolving an id no attributed commit explains with `user/<id>`.
Results go to `_drafts/private/gh-renames.json`, rewritten after every handle.

`rank` prints each dead handle that resolves to another account. PROVEN means
a noreply address of the form `<id>+<old handle>@users.noreply.github.com`
carries that account's id: GitHub mints the address from the immutable id, so
the two handles are one account. NAME means only the author name matched,
which is weak on its own because a commit's author name is whatever the
committer typed; a look-alike handle registered later (a letter O for a zero)
lands here too.

A proven rename is filed the way the former-handles entry in
`direct-observations.json` was: the account's current profile, with the old
handle kept as it is (a dead handle is still what older reporting names) and
any further former handle recorded as a `username`, never as a profile URL,
because an abandoned handle can be registered by anyone.
