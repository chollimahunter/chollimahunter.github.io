# Security policy

## Reporting a vulnerability in this site

Chollima Hunter is a static site. It has no backend, no database, and no API,
so the attack surface is the build pipeline, the published pages, and the
client-side JavaScript that runs in a reader's browser. Reports that matter
here look like cross-site scripting through an indicator value that reaches a
page unescaped, a supply-chain problem in the build, a workflow that can be
made to run untrusted code, or a leaked credential.

Send the report by email to the address in the site's
[security.txt](https://chollimahunter.github.io/.well-known/security.txt),
rather than raising it anywhere public, so the problem can be fixed before it
is described in public.

If the repository is public and private vulnerability reporting is enabled on
it, a
[security advisory](https://github.com/chollimahunter/chollimahunter.github.io/security/advisories/new)
is an equally good route. Do not open a public issue with the details in it.

Please include what you did, what happened, and the page or file involved. A
proof of concept helps. There is no bounty.

## What is not a vulnerability here

- **Indicators the site publishes.** Domains, wallet addresses, package names
  and file hashes are the content, not a leak. They are rendered as text
  rather than as clickable links precisely so a reader does not visit them by
  accident.
- **The hunting queries.** They are detection logic for defenders, published
  with their sources.
- **Personal data about named individuals.** Every such entry cites a public
  record. If you believe an entry is wrong or concerns an identity stolen from
  an uninvolved person, that is a correction request rather than a security
  report; see
  [Corrections and removal requests](https://chollimahunter.github.io/about/#corrections).

## Reporting the activity this site tracks

If you have found a suspected DPRK IT worker inside an organisation, a
fraudulent interview that delivered malware, or a cryptocurrency theft, report
it to law enforcement rather than here. The
[reference section of the Sources page](https://chollimahunter.github.io/sources/#reference)
lists the intake points, starting with the FBI Internet Crime Complaint Center.

New indicators and profile leads go through the
[submission form](https://chollimahunter.github.io/submit/), which is reviewed
by a person before anything is published.
