---
name: frontend-ui
description: Enforces this site's frontend conventions when writing or reviewing any Nunjucks template, CSS, or page layout in the Chollima Hunter repo — no inline CSS (reuse the tokens and component classes in src/assets/css/tokens.css instead), visual consistency across pages, and reusing existing markup patterns rather than copy-pasting new ones. Also covers verifying the rendered site with the Playwright MCP browser tools against the local dev server. Use this whenever a task touches a .njk template, tokens.css, or asks for a visual check of the site.
---

# Frontend and UI conventions for Chollima Hunter

Every visible page on this site is styled from a single file, `src/assets/css/tokens.css`: design tokens (color, spacing, radius, typography, motion) as CSS custom properties at the top, then a set of reusable component classes below (`.card`, `.card-grid`, `.badge--*`, `.results-table`, `.tag-chip`, `.disclaimer-banner`, `.tab-bar`, `.table-scroll`, form styles). The whole point of that single-file structure is that a visual change made once shows up everywhere consistently — anything that works around it quietly breaks that guarantee.

## No inline CSS

Before finishing any template change, check for a `style="..."` attribute or a `<style>` block. If you find yourself reaching for one, it means either an existing token/class already covers the need and should be reused, or a genuinely new pattern has come up that belongs in `tokens.css` as a named class, not inline. The one time this came up for real in this repo — three table wrappers needing horizontal scroll on narrow viewports — the fix was a `.table-scroll { overflow-x: auto; }` utility class added to `tokens.css`, not an inline style repeated three times. That's the template to follow: name the pattern, put it in one place, reference it by class.

## Reuse before inventing

Check the existing component classes in `tokens.css` before writing new CSS: `.card` / `.card-grid` for card layouts, `.badge--*` for status/category chips, `.results-table` for tabular data (paired with `.table-scroll` when the table can overflow), `.tag-chip` for inline tags, `.disclaimer-banner` for the manual-review notices that appear on tool-results pages, `.tab-bar` for the profile-section navigation. New visual tokens (colors, spacing values) belong in the `:root` custom-property block, not as hardcoded hex codes or pixel values scattered through templates.

This repo doesn't have a Nunjucks macro library yet — reuse currently happens through `{% include %}` partials (see `svg/chollima.njk`, `svg/star.njk`, `partials/profiles-tab-bar.njk`) and copy-pasted markup in places like `profile.njk`. If a change introduces a third or fourth copy of the same block of markup, that's a good moment to suggest pulling it into a partial or macro rather than adding a fourth copy — but don't force that refactor on a change that's only touching one instance.

## Verifying the site visually with Playwright MCP

For any change that could affect layout or rendering, check it against the running dev server rather than just reading the template. Start the dev server first if it isn't already running (`npm run serve`, which serves on `http://localhost:8080`), or, to check a finished `npm run build`, run `npm run preview` (`http://127.0.0.1:8081`, stops itself after 15 idle minutes). Never start a Python or npx static server: a hook refuses them, because they were left running twice. Stop a dev server you started when the check is done (the PowerShell recipe in CLAUDE.md), then confirm nothing listens on 8080. Then use the Playwright MCP tools:

1. Navigate to the affected page(s) — for a broad check, the useful set is `/`, `/about/`, one page under `/profiles/<slug>/`, `/profiles/identifiers/`, `/etherhiding/results/`, `/repo-scanner/`, and `/submit/`.
2. Check `browser_console_messages` for each page — a clean console (no errors, no warnings) is the bar; anything else needs explaining before the change is considered done.
3. Take a snapshot or screenshot at a narrow viewport (around 375px wide, representative of mobile) and a wide one (around 1280px) using `browser_resize`, to confirm nothing overflows, clips, or collapses awkwardly at either end.
4. If the change touched something related to the inline-CSS cleanup or table rendering, confirm in the snapshot/DOM that no `style="..."` attribute reappeared and that the expected class (e.g. `table-scroll`) is present instead.

This is a verification step, not a substitute for reading the template change itself — use it to catch what reading the code can't show you, like actual overflow, actual contrast, actual console errors.
