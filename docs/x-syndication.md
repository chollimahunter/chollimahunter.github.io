# x-syndication: reading X posts without a browser

`scripts/x-syndication.js` reads posts from X through the public syndication
endpoint the embed widget uses. It needs no session and no account, it is not
throttled the way a browser on x.com is after a few hours of reading, and it
returns a post's full text, its media and the id of the post it replies to.
It is the route used for transcribing X sources into `x-dossiers.json`
(`docs/x-dossiers.md`).

## Usage

```
node scripts/x-syndication.js --post <id|url>             # one post
node scripts/x-syndication.js --thread <id|url>           # the post and every parent above it
node scripts/x-syndication.js --media <id|url> --out dir  # save its images at full resolution
node scripts/x-syndication.js --thread <id|url> --out dir # both
```

A post is given as its numeric id or any status URL.

## What it cannot do

It cannot enumerate. A response names the post it replies to but nothing
below it, so a thread is recovered by walking up from a post inside it and in
no other way, and the replies under a post have to be found some other way.
Finding a researcher's posts in the first place is still the date-window sweep
(`from:<handle> since: until:`) and the Photos tab, done by hand. The older
`/timeline/conversation` endpoint, which would have listed a reply chain, now
answers with an empty body, and `srv/timeline-profile` answers 429; the script
probes both and reports what they return rather than assuming.

## What it does not decide

It prints what the endpoint returned and saves the images. It does not decide
what in a post is an indicator. Every rule in `docs/x-dossiers.md` about
attribution, about the victims of impersonation, and about the difference
between an account that links to another and one that is the same person
applies to reading its output.
