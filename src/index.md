---
layout: base.njk
title: "Home"
description: "Chollima Hunter tracks, documents, and exposes DPRK state-sponsored cyber campaigns, actors, and infrastructure using publicly sourced records."
extra_head: '<script src="/assets/js/ioc-search.js" defer></script><script src="/assets/js/grid-more.js" defer></script>'
---
{#
  src/index.md — Home page

  Markdown source — edit the prose below like a normal text document. It
  still supports Nunjucks tags (11ty renders .md through Nunjucks first),
  which is how the counts and the two data-driven lists below work.

  Every count on this page is derived, never typed: the stat row reads
  iocIndex, personas, collections.profiles and sources, and each cluster card
  counts the profiles carrying that tag. A hand-written number here would be
  wrong the next time a data file changed.

  The `id` attributes are load-bearing: layouts/profile.njk links each cluster
  tag to that cluster's own page at /clusters/{id}/, falling back to
  /#actor-cluster-taxonomy on this page only when the tag matches no taxonomy
  entry; /about/ links back to #about-dprk-cyber-operations, and repo-scanner
  links to #contagious-interview. Don't rename them.

  The <ul> blocks below deliberately contain no blank lines. markdown-it ends
  an HTML block at the first blank line, so a gap inside one would drop the
  rest of the list back into Markdown parsing and emit broken markup.
#}

<section class="hero hero--home">

<div class="hero__wordmark">
<h1>Chollima Hunter</h1>
<p class="hero__wordmark-ko" lang="ko">{% include "partials/ko-spread.njk" %}</p>
</div>

</section>

<section>

<div class="ioc-search ioc-search--compact" hidden data-ioc-search data-ioc-defer data-ioc-blank>
{% set searchBox = { id: "ioc-search-input", label: "Check a name, email, GitHub or LinkedIn account, wallet, domain and more", labelHidden: true, placeholder: "Check a name, email, GitHub or LinkedIn account, wallet, domain, etc.", count: "data-ioc-count" } %}{% include "partials/search-box.njk" %}
</div>
<p class="ioc-search__tagline">A free, public index tracking North Korea's cyber operations.</p>
{% set iocTable = { results: true } %}{% include "partials/ioc-table.njk" %}
<noscript>
<p class="form-hint">Searching needs JavaScript. The full index is browsable without it at <a href="/remote-workers/">Remote Workers</a>, and every indicator has its own page under <a href="/indicators/">Indicators</a>.</p>
</noscript>

<ul class="stat-row">
<li><a class="stat stat--lead" href="/indicators/"><span class="stat__figure">{{ iocIndex.totals.all | thousands }}</span><span class="stat__label">Indicators</span><span class="stat__note">Emails, accounts, packages, wallets and repositories</span></a></li>
<li><a class="stat" href="/remote-workers/personas/"><span class="stat__figure">{{ personas.length }}</span><span class="stat__label">Fake personas</span><span class="stat__note">Invented identities used to apply for jobs</span></a></li>
<li><a class="stat" href="/profiles/"><span class="stat__figure">{{ collections.profiles.length }}</span><span class="stat__label">Named individuals</span><span class="stat__note">People named in indictments, wanted notices and sanctions</span></a></li>
{%- set ownSources = [] %}{% for source in sources.all %}{% if source.publisher and source.publisher.startsWith("Chollima Hunter") %}{% set ownSources = (ownSources.push(source), ownSources) %}{% endif %}{% endfor %}
<li><a class="stat" href="/sources/"><span class="stat__figure">{{ sources.total }}</span><span class="stat__label">Sources</span><span class="stat__note">{{ (sources.total - ownSources.length) | thousands }} published reports and posts{% if ownSources.length %}, and {{ ownSources.length }} of this site&rsquo;s own records{% endif %}</span></a></li>
</ul>

</section>

<section>

## What's a Chollima?

<ol class="glyphs" aria-label="Chollima, character by character">
<li class="card glyph"><span class="glyph__char" lang="ko">천</span><span class="glyph__roman">cheon</span><span class="glyph__meaning">a thousand</span></li>
<li class="card glyph"><span class="glyph__char" lang="ko">리</span><span class="glyph__roman">ri</span><span class="glyph__meaning">a Korean unit of distance, about 0.4 km (a quarter mile)</span></li>
<li class="card glyph"><span class="glyph__char" lang="ko">마</span><span class="glyph__roman">ma</span><span class="glyph__meaning">horse</span></li>
</ol>

<div>

The thousand-<em>ri</em> horse: a winged horse from Korean legend, said to cover a thousand <em>ri</em> (about 400 km) in a day. North Korea made it a national symbol of speed, and a Chollima statue still stands over Pyongyang.

Security firm CrowdStrike names North Korea's hacking groups after it. This site hunts them.

</div>
</section>

<section>

## How the scheme works

<ol class="steps">
<li class="card step"><span class="step__number">1</span><h3 class="step__title">Build a fake developer</h3><p>A stolen or AI-made photo, an invented CV, and GitHub and LinkedIn accounts to match.</p></li>
<li class="card step"><span class="step__number">2</span><h3 class="step__title">Get hired remotely</h3><p>Pass the interviews, often with help from people abroad who receive the work laptop and keep it online.</p></li>
<li class="card step"><span class="step__number">3</span><h3 class="step__title">Send it home</h3><p>The salary goes to the regime. The access can be used to steal code, data or crypto.</p></li>
</ol>

It also runs the other way: fake recruiters send real developers a "coding test" that installs malware. Researchers call that Contagious Interview.

</section>

<section>

## Use it

<ul class="card-grid cluster-grid">
<li class="card"><a class="cluster-card__link" href="/remote-workers/"><span class="cluster-card__name">Search the index</span><span class="cluster-card__body">Check an applicant's email, GitHub or LinkedIn against everything reported.</span></a></li>
<li class="card"><a class="cluster-card__link" href="/remote-workers/red-flags/"><span class="cluster-card__name">Spot the red flags</span><span class="cluster-card__body">What a fake candidate looks like, from CV to interview.</span></a></li>
<li class="card"><a class="cluster-card__link" href="/hunts/"><span class="cluster-card__name">Hunt in your network</span><span class="cluster-card__body">Ready-to-run queries for the tools these operators leave behind.</span></a></li>
<li class="card"><a class="cluster-card__link" href="/repo-scanner/"><span class="cluster-card__name">Scan your code</span><span class="cluster-card__body">Find the malicious packages and repositories in your dependencies.</span></a></li>
</ul>

</section>

<section>

<h2 id="about-dprk-cyber-operations">Who's behind it</h2>

<p class="section-lede">Not freelance criminals. A state program, run by three arms of the North Korean government.</p>

<div class="org-tree" id="regime-structure">
<div class="card org-tree__root"><span class="org-tree__name">The North Korean state</span></div>
<span class="org-tree__trunk" aria-hidden="true"></span>
<ul class="org-tree__branches">
<li class="card org-tree__branch org-tree__branch--main">
<a class="org-tree__name" href="/clusters/rgb-reconnaissance-general-bureau/">General Reconnaissance and Information Bureau</a>
<span class="org-tree__note">Military intelligence, formerly the Reconnaissance General Bureau (RGB). Theft, sabotage and spying abroad, and most of the hacking.</span>
<ul class="org-tree__groups"><li><a class="tag-chip" href="/clusters/lazarus-group/">Lazarus Group</a></li><li><a class="tag-chip" href="/clusters/apt38/">APT38</a></li><li><a class="tag-chip" href="/clusters/andariel/">Andariel</a></li><li><a class="tag-chip" href="/clusters/kimsuky/">Kimsuky</a></li><li><a class="tag-chip" href="/clusters/moonstone-sleet/">Moonstone Sleet</a></li></ul>
</li>
<li class="card org-tree__branch">
<span class="org-tree__name">National Intelligence Agency</span>
<span class="org-tree__note">The secret police, formerly the Ministry of State Security. Spies on defectors, activists and South Korea.</span>
<ul class="org-tree__groups"><li><a class="tag-chip" href="/clusters/apt37/">APT37</a></li></ul>
</li>
<li class="card org-tree__branch">
<span class="org-tree__name">Munitions Industry Department</span>
<span class="org-tree__note">The Workers' Party office behind the weapons programme. Its trading company, Korea Ryonbong, coordinates the fake IT workers, whose units sit across the military, state firms and front companies.</span>
<ul class="org-tree__groups"><li><a class="tag-chip" href="/clusters/contagious-interview/">IT workers / Famous Chollima</a></li></ul>
</li>
</ul>
<p class="org-tree__unplaced">Not placed: <a href="/clusters/konni/">Konni</a>, and <a href="/clusters/polinrider/">PolinRider</a>, a campaign reported as merged with the IT-worker cluster.</p>
</div>

<p class="org-tree__source">Mapping per {% set externalLink = { url: "https://www.sekoia.com/blog/beyond-lazarus-organization-of-dprk-cyber-capabilities", text: "Sekoia (September 2026)" } %}{% include "partials/external-link.njk" %}, which records the agencies' 2026 names. North Korea reorganises these units often, and researchers disagree on where some groups sit; where a profile names a unit, its own citation is the authority.</p>

</section>

<section>

<h2 id="actor-cluster-taxonomy">Meet the groups</h2>

<p class="section-lede">Each one opens its own page: what it does, what a defender would see, and the research worth reading.</p>

<ul class="card-grid cluster-grid">
{%- for cluster in clusters %}
<li class="card" id="{{ cluster.id }}"><a class="cluster-card__link" href="{{ cluster.url }}"><span class="cluster-card__name">{{ cluster.label }}</span><span class="cluster-card__count">{% if cluster.profiles.length %}<span class="count-figure">{{ cluster.profiles.length }}</span> profile{% if cluster.profiles.length != 1 %}s{% endif %}{% else %}No profiles yet{% endif %}</span><span class="cluster-card__count cluster-card__count--iocs">{% if cluster.indicators.total %}<span class="count-figure">{{ cluster.indicators.total | thousands }}</span> indicator{% if cluster.indicators.total != 1 %}s{% endif %}{% else %}No indicators yet{% endif %}</span><span class="cluster-card__body">{{ cluster.description }}</span></a></li>
{%- endfor %}
</ul>

</section>

<section>

## All profiles

{%- set pictured = [] %}{% set unpictured = [] %}
{%- for profile in collections.profiles %}{% if profile.photo_slot and profile.photo_slot.image_path %}{% set pictured = (pictured.push(profile), pictured) %}{% else %}{% set unpictured = (unpictured.push(profile), unpictured) %}{% endif %}{% endfor %}
<ul class="profile-grid" id="all-profiles" data-grid-limit="{{ limits.list }}">
{%- for profile in pictured.concat(unpictured) %}{% set tileProfile = profile %}{% include "partials/profile-tile.njk" %}{% endfor -%}
</ul>
{% set gridMore = { target: "#all-profiles", noun: "profiles" } %}{% include "partials/grid-more.njk" %}

<div class="disclaimer-banner">
<strong>Disclaimer</strong>
Every claim here comes from a cited public record, and confidence levels reflect the source's own characterisation rather than a determination by this site. See the <a href="/sources/#sourcing-methodology">sourcing methodology</a>. If something looks inaccurate or unfairly sourced, flag it via <a href="/submit/">Submit IOC/Profile</a>.
</div>

</section>
