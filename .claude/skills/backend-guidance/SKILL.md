---
name: backend-guidance
description: Stack-agnostic guidance for if and when backend, database, or server-side routing code is ever proposed for the Chollima Hunter repo — which today is a fully static Eleventy site deployed to GitHub Pages with no server, no database, and no API routes (the /submit/ page sends submissions via a mailto: link, with no third-party service or backend of its own). This skill does not scaffold a backend; it only applies once someone is actually proposing to add server-side code, and its first job is to flag that decision itself before any implementation starts. Use this when a task proposes adding a server, an API, a database, or any request-time backend logic to this repo.
---

# Backend guidance for Chollima Hunter

There is no backend in this repo today. Confirm that's still true before assuming otherwise — check for a server entry point, an `/api` directory, a database client dependency, or serverless function config before treating any part of this site as dynamic. As of this skill being written, submissions go out as a `mailto:` link to the site owner's address rather than through any code in this repository or any third-party service, and every other page is pre-rendered at build time.

## The decision to add one comes before the code

Adding a backend changes the deployment model, not just the codebase — this site currently ships as static files to GitHub Pages, and GitHub Pages cannot run server-side code. Introducing a backend means either standing up separate infrastructure (a serverless function platform, a small always-on server) alongside the static site, or moving the deploy target somewhere that supports both. That's a real architectural choice with cost, maintenance, and security surface implications, and it should be raised explicitly to whoever owns this project before implementation begins — don't treat "add an API route" as a routine code change here the way it might be in a repo that already has a server.

## If a backend is genuinely being added

Once that decision has been made deliberately, these conventions apply regardless of which framework or language gets chosen:

- **Routing**: organize routes by resource, keep route handlers thin (parse input, call a function that does the work, format the response), and keep the routing table itself easy to scan in one place rather than scattered across the codebase.
- **Database access**: use parameterized queries or an ORM/query-builder that parameterizes for you — never build a query by concatenating a string with user-supplied input. Keep schema changes in versioned migration files, applied in order, rather than hand-editing a live schema.
- **Secrets**: credentials, API keys, and connection strings go in environment variables or the platform's secret store (GitHub Actions secrets, for a CI-triggered job — this repo's existing `sync-itworker-datasets.yml` workflow already follows this pattern for its own external fetch, with no credential embedded in the script or the repo). Never commit a secret to the repository, including in a config file that looks internal-only.
- **Input from the public**: this site already has an explicit philosophy about public input — nothing submitted by a visitor gets published automatically, and factual claims about named individuals require independent sourcing before going live (see `CONTENT_GUIDE.md` and `docs/submission-review-assist.md`). Any new backend feature that accepts public input should carry that same review-before-publish gate rather than relaxing it just because the mechanism changed from a form to a direct API call.

## What this skill is not

It's not a template for scaffolding a backend preemptively, and it's not a signal that one is planned. It exists so that if the question ever comes up, the answer is grounded in this repo's actual constraints (static hosting today, a strong existing norm against unreviewed publication) rather than generic advice that ignores them.
