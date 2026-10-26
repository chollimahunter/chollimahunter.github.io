---
name: repo-code-review
description: Reviews code changes in this Eleventy/Nunjucks static-site repo (Chollima Hunter) for efficiency, unnecessary comments, security issues, and correctness bugs, scoped to what this project's stack actually is — a static site with no backend, database, or API. Complements the general code-review and security-guidance plugins with checks specific to this repo's conventions rather than restating generic advice. Use this before committing, before opening a pull request, or whenever asked to review a diff, a script, or a template change in this repo.
---

# Code review for Chollima Hunter

This repo is a static Eleventy 2.x site with Nunjucks templates and no backend, database, or API — every page is generated at build time from files under `src/`. The general `code-review` and `security-guidance` plugins already cover broad correctness, efficiency, and security practice; this skill exists to catch the things specific to how this particular repo is put together, which a generic reviewer wouldn't know to look for.

## No backend exists — treat that as a fact to protect, not assume away

If a change introduces a server, an API route, a database client, or anything that implies request-time server-side execution, stop and flag it explicitly rather than reviewing it as if it were normal. This site deploys to GitHub Pages as static files; adding a backend is an infrastructure decision with real consequences (a different hosting model entirely), and it should be surfaced to whoever is reviewing the change before the code itself is judged on its merits. The `backend-guidance` skill has more detail on what a backend introduction should look like if one is ever genuinely being added.

## Utility scripts (scripts/*.js)

The one real script in this repo, `scripts/sync-dtex-itworker-emails.js`, establishes the pattern any sibling script should follow:

- Resolve paths relative to the script's own location with `path.join(__dirname, ...)`, never a hardcoded absolute path or an assumption about the current working directory. A script that's one level deep in `scripts/` reaches `src/_data/...` with a single `".."`, not several — get this arithmetic right, since a wrong relative path fails silently or writes to the wrong place rather than raising an obvious error.
- If a script feeds a GitHub Actions workflow, preserve whatever stdout contract the workflow parses — for the sync script, that's a final `CHANGED=true` or `CHANGED=false` line the workflow's `grep` branches on. Changing that output format without updating the workflow breaks the automation invisibly (it'll "succeed" while doing nothing).
- Never fabricate or guess at data. The existing script's philosophy — record what happened, including failures, rather than inventing a plausible-looking result — is worth holding a new script to.

## Nunjucks and Eleventy conventions

This repo chains layouts through Eleventy's data cascade, not `{% extends %}`: a page sets `layout: base.njk` (or `layouts/profile.njk`) in its front matter, and Eleventy composes the chain automatically. A template that sits in the middle of a chain (like `layouts/profile.njk`, which both extends `base.njk` and gets extended by pages that use it) correctly uses `{% block content %}` to mark where the next layer's content lands — a leaf page template does not need one. When reviewing a new or changed template, check that this pattern is followed rather than introducing a different templating idiom partway through the site.

Check `.eleventy.js` collection and config changes against actual 11ty semantics — for example, the `profiles` collection reads every `src/profiles/*.json` file directly off disk with Node's `fs` module rather than through Eleventy's own data-file conventions, which is deliberate (documented in that file's comments) rather than an oversight.

## Comments: prune restatement, keep rationale

Strip a comment if it just repeats what the next line of code already says. Keep a comment if it explains something the code can't say for itself — why a value is what it is, a constraint that would otherwise look arbitrary, a workaround for a specific quirk. This repo's own style already leans this way: `.eleventy.js` and `src/_includes/layouts/profile.njk` carry substantial comments precisely because they explain non-obvious decisions (why the profiles collection is registered the way it is, why a mid-chain layout needs `{% block content %}` when a leaf page doesn't). Don't treat comment density as itself a problem — judge each comment on whether removing it would lose real information.

## Citations on factual claims

Any content change that asserts a specific fact about a named individual — a real person, not a pseudonym or persona label — needs a citation in that entry's `sources[]`, per `CONTENT_GUIDE.md`. This applies to profile JSON files, IOC datasets, and prose pages alike. A change that adds or edits such a claim without a source is a correctness issue in this repo's specific sense: an unsupported claim about a real person is the single thing this site's own stated methodology exists to prevent.
