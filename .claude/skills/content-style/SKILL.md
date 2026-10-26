---
name: content-style
description: Enforces the writing style for the Chollima Hunter site — no emojis anywhere, ever; formal, neutral, third-person tone; factual claims about named individuals always carry a citation; and prose that reads as connected, natural writing rather than choppy bullet-heavy fragments where narrative is called for. Applies both to site content (profile pages, hunt descriptions, the about page) and to Claude's own commit messages, pull request descriptions, and explanations while working in this repo. Use this whenever writing or editing any content file in this repo, or any commit message, PR text, or explanation about work done here.
---

# Writing style for Chollima Hunter

This site documents real people and real campaigns attributed to a state actor, which is exactly the kind of subject where tone and rigor matter more than usual. The existing content already reads this way — the goal here is to keep new writing consistent with it, not to introduce a new voice.

## No emojis, ever

Not in site content, not in commit messages, not in pull request descriptions, not in explanations given while working in this repo. This is a hard rule with no situational exception — the subject matter (state-sponsored threat activity, real named individuals) doesn't pair with a casual visual register, and consistency matters more than any single emoji would help any single sentence.

## Tone: formal, neutral, third-person

Write the way the existing profile and hunt pages already do: measured, factual, without editorializing adjectives that imply certainty the sourcing doesn't support. Avoid words like "proves" or "confirms" unless the cited source itself uses language that strong — if a source says "assessed with moderate confidence," the site's own text should reflect that same hedge, not round it up. This mirrors the disclaimer banners already used throughout the site and should be the working assumption for any new prose, not something to re-derive each time.

## Every claim about a named individual needs a citation

This is `CONTENT_GUIDE.md`'s rule, and this skill doesn't restate the mechanics of it — just flag it: if new or edited text asserts something specific about a real, named person, check that the corresponding `sources[]` entry actually supports it before treating the writing as finished. A well-written sentence that isn't sourced is not acceptable on this site regardless of how good the prose is.

## Prose over bullet lists, where prose is the right call

For narrative sections — the story of a campaign, the context around a threat actor's activity — write connected paragraphs, not a list of disconnected fragments. A reader following an actor's history should get sentences that build on each other, not a bulleted summary that reads like notes. Bullets remain the right choice for genuinely structured, itemizable content: IOC lists, field references, step-by-step procedures like the ones in `docs/repo-scanner-github-scan.md`. The test is whether the content is actually a list of discrete items or a narrative being forced into list shape to look scannable — the former belongs in bullets, the latter doesn't.

## This applies to Claude's own writing in this repo too

Commit messages, PR descriptions, and explanations of work done in this repo should follow the same tone and emoji policy as the site content itself — plain, direct, no emojis, no inflated claims about what a change accomplishes.
