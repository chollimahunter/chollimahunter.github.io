# review-assist

## What this is

`review-assist` is a MANUAL tool, not part of the automated 11ty site
build. The site owner runs it by hand, on demand,
whenever a new submission arrives by email at the address published on the
`/submit/` page, defined at `src/submit/index.njk`.

It never runs unattended and never writes to a live data directory. Its only
output is a **draft** file under `_drafts/` plus a short human review
checklist — a human must explicitly move/merge the draft into
`src/profiles/` or an IOC ruleset under `_data/iocs/` (see
`CONTENT_GUIDE.md` for both field shapes) before it goes live.

## When to run it

The site owner runs this (e.g. by invoking the site's Claude session with
this tool's instructions and the raw submission) after receiving a
submission email, whenever they want help turning it into a properly-shaped
draft instead of hand-writing the JSON themselves.

## Inputs

1. **Raw submission content** — the site owner pastes in (or supplies as a
   file) the body of the submission email, filled in against the template on
   `/submit/`: a `submission_type` line (`New IOC` | `New Profile` |
   `General tip`), an optional contact line, a `description`, and whichever
   of the type-specific fields were filled in (indicator type/value/campaign
   for New IOC; subject name, alleged activity, and source links for New
   Profile). See `src/submit/index.njk` for the exact template text/labels —
   the submitter may not follow it exactly, so read the raw text rather than
   expecting strict key/value pairs.
2. **`submission_type`** — drives which schema and which draft directory to
   target. `general_tip` submissions do not produce a schema draft at all
   (see step 6 below).

## Procedure

Follow these steps in order. Do not skip the sourcing gate in step 4 — it is
the whole reason this is a manual-assist tool rather than an auto-publish
pipeline.

### 1. Identify target shape

- `submission_type: new_profile` → see `CONTENT_GUIDE.md`'s profile section
  for the field shape.
- `submission_type: new_ioc` → see `CONTENT_GUIDE.md`'s IOC section for the
  field shape.
- `submission_type: general_tip` → no fixed shape; skip to step 6.

### 2. Map free text into schema fields

Read every field the submitter provided and map it onto the schema's fields
as best as reasonably inferable:

- **New Profile**: `profile_name` → `display_name` (and/or `aliases` if it
  reads as an alias list); `profile_activity` + `description` → informs
  `cluster_taxonomy` guesses (only set a tag if it clearly matches one of
  the taxonomy labels on `src/index.md` — otherwise leave
  `cluster_taxonomy` empty and note it in the review checklist) and the
  narrative context feeding `disclaimer`; `profile_sources` → `sources[]`
  (see step 4 — this is the ONLY field that populates `sources`).
- **New IOC**: `ioc_type` → `ioc_type` (validate it's one of the schema's
  `enum_values`; if not, leave blank and flag it); `ioc_value` → `value`;
  `ioc_campaign` → `campaign[]` (split on commas if multiple); `description`
  → `description`; sources come only from any URLs present in the raw
  submission text (see step 4).

**Leave a field blank rather than guessing** whenever the submission doesn't
clearly supply it. Do not infer `confidence_level` from tone or your own
judgment of plausibility — default it to `low` unless the submission itself
cites a source whose own stated confidence is higher (per the sourcing
methodology at `/sources/#sourcing-methodology`: confidence_level must reflect
the cited source's own characterization, not this tool's).

### 3. Never invent identity/schema metadata

- `slug` (profiles) / `id` (IOCs): derive mechanically from `display_name` /
  `value` (kebab-case), don't fabricate an unrelated identifier.
- `last_updated` / `date_added`: use today's date (ISO 8601), not a guessed
  historical date.
- Do not populate `emails`, `phone_numbers`, `fake_ids`, `personas`, or
  `photo_slot` on a profile draft unless the submission itself supplied
  that specific data with a citable source — these are exactly the
  highest-risk fields for unverified claims about a named individual.

### 4. Sourcing gate — NON-NEGOTIABLE

- Populate `sources[]` **only** from links the submitter actually provided
  (`profile_sources` textarea, or any URL literally present in
  `description`/`ioc_campaign`/other free text) — one `sources[]` entry per
  URL, with `title`/`publisher`/`date`/`type` filled in only where they can
  be read off the linked page's own metadata the submitter described, or
  left blank rather than guessed.
- **Never fabricate a citation to satisfy the schema's `required: true` on
  `sources`.** If the submitter provided zero links:
  - Leave `sources: []` (empty array) in the draft.
  - Set a top-level `review_status: needs_sourcing` field on the draft (this
    field is NOT part of the live profile/IOC schema — it exists only in
    the draft file as a visible flag that the human reviewer must add
    sourcing before this can be merged into `src/profiles/` or
    `_data/iocs/`).
  - Call this out prominently in the review checklist (step 6).
- If the site owner supplies additional source links themselves *during*
  the review session (i.e. they found supporting public records after
  reading the tip), those may be added to `sources[]` — but that is the
  human reviewer's own citation, added explicitly by them, not something
  this tool infers or searches for on its own.

### 5. Write the draft file

Write a JSON file directly (no intermediate tooling needed):

- Path:
  - New Profile → `_drafts/profiles/{slug}-draft.json`
  - New IOC → `_drafts/iocs/{id}-draft.json`
  - If a `{slug}-draft.json` already exists, use a numeric suffix like
    `{slug}-draft-2.json` instead of overwriting a prior reviewer's work.
- Content: the mapped object from steps 2–4, plus:
  - `review_status`: `"needs_sourcing"` if `sources` is empty, otherwise
    `"ready_for_review"`.
  - `submitted_via`: `"email"`.
  - `submitter_contact`: whatever the submitter provided, or `null`.
  - `raw_submission`: the original unmodified submission text, preserved
    verbatim so the human reviewer can always check the draft against the
    source material.
- `sources` being an empty array (per step 4) is an intentional, explicitly
  noted exception, not a missing field to silently fill in.

**Never write to `src/profiles/` or `_data/iocs/*.json` directly.** Those
are live, published directories. This tool's output always
lands in `_drafts/`.

For `general_tip` submissions, there is no schema draft — instead, just
produce the review checklist (step 6) summarizing the tip so the site owner
can decide manually whether it warrants turning into a New IOC / New Profile
submission themselves, or just an internal note.

### 6. Output a review checklist

Alongside the draft file (or in place of one, for general tips), output a
short human-readable checklist:

```
Submission type: {new_ioc | new_profile | general_tip}
Draft written to: {path, or "N/A — general tip"}

- [ ] Sources present? {yes (N sources) | NO — flagged needs_sourcing}
- [ ] Does confidence_level match the strength of the sourcing actually
      provided? (default was set to "low" — upgrade only if a cited
      source's own language supports it)
- [ ] Any red flags of a bad-faith or defamatory submission? (e.g. no
      sourcing at all for a serious claim about a named private
      individual, sourcing that doesn't actually say what the submission
      claims it says, vague/unverifiable accusations, submitter pushing a
      personal grudge)
- [ ] cluster_taxonomy tags (if any) match the canonical list on
      /#actor-cluster-taxonomy exactly?
- [ ] Does this look like it should be merged as-is, edited first, or
      rejected outright?

Reviewer notes: {any assumptions made while mapping fields, anything left
blank that the reviewer may be able to fill in, anything ambiguous in the
raw submission text}
```

## Constraints

- This tool is a manual workflow — it is not wired into the
  automated 11ty build and never runs unattended.
- Every draft file must be reviewable in isolation: it must contain the
  original raw submission text, so a human never has to trust this tool's
  mapping without the source material next to it.
- If in doubt about any field, leave it blank and note it in the checklist
  rather than guessing.
