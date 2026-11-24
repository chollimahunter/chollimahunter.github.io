# Certificate-transparency pivot

`scripts/ct-pivot.js` reads certificate-transparency logs for every indexed
operator domain, for the domains and hosts that share its certificates.

```
node scripts/ct-pivot.js collect [--force] [--limit N] [domain ...]
node scripts/ct-pivot.js rank
```

Every publicly trusted certificate is logged with every name on it. An
operator who puts two of its domains on one certificate ties them together;
one who reuses a key pair across certificates does the same; a certificate
for a subdomain shows a host no report named.

`collect` takes each indexed `domain` or `personal_site` value that is itself
a registrable domain (the same rule and Public Suffix List as
`scripts/enrich-domains.js`, so `name.vercel.app` and `name.us.com` are never
widened to the platform or private registry they sit under) and asks Cert
Spotter's public API for every certificate naming it or a subdomain, with its
names and key hash. When Cert Spotter refuses, crt.sh answers instead, without
key hashes. No key is needed. Cert Spotter allows about 100 unauthenticated
requests an hour, so a full pass of about 480 domains takes about five hours;
run it in the background. Results go to `_drafts/private/ct-pivot.json` after
every domain, so a stopped run resumes.

A certificate a platform issues for many unrelated customers ties nothing
together, so a certificate naming more than six registrable domains, or a
known shared host (Cloudflare's shared certificates, Heroku, Azure, Netlify,
Vercel, GitHub Pages and similar), is set aside.

`rank` prints three tables, each against what the index holds:

- **other registrable domains on the same certificates**, the strong lead;
- **key hashes shared by two or more indexed domains**, which tie them
  together;
- **subdomains** of indexed domains.

A row is a lead. A domain can change hands, so a sibling on a certificate
from years before the operator registered the seed belongs to an earlier
owner: compare the certificate date with the seed's registration date
(`scripts/data/domain-registration.json`). Read each before filing, and keep
the results in the private repository.
