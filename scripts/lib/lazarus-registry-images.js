/**
 * lazarus-registry-images.js — which of the lazarus.group registry's images
 * this site republishes, and how each is captioned.
 *
 * The decision for every image is made by eye and recorded in
 * scripts/data/lazarus-registry-images.json, keyed by the registry's own
 * image path. An image with no recorded decision is not used: a refresh that
 * finds new images leaves them off the page until someone has looked at them,
 * because no tag or heuristic separates a portrait from an identity card, a
 * crowd or a child in the background (the registry tags all of those `face`).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DECISIONS = path.join(__dirname, "..", "data", "lazarus-registry-images.json");
const SITE_SRC = path.join(__dirname, "..", "..", "src");

function loadDecisions() {
  return JSON.parse(fs.readFileSync(DECISIONS, "utf8")).images;
}

function photoCaption(image, decision) {
  const said = image.short_description ? `, captioned there as “${image.short_description}”` : "";
  switch (decision.kind) {
    case "document":
      return (
        `Identity document published by the registry under this persona${said}. The registry presents it as a document ` +
        "used for this identity. Its name, number and photograph are the document's own and may belong to a real person " +
        "whose identity was stolen to build the persona."
      );
    case "wanted":
      return (
        `Photograph the registry publishes for this persona${said}, with the name printed beneath it. The photograph and ` +
        "name are the registry's attribution of who operated the identity."
      );
    case "group":
      return (
        `Photograph published by the registry under this persona${said}. Others in it are shown as published; only the ` +
        "persona is attributed by the registry."
      );
    case "resume":
      return `Resume published by the registry under this persona${said}. Every employer, degree and skill in it is the document's own claim.`;
    case "avatar":
      return `Avatar published by the registry under this persona${said}. It is the picture the identity presented, not a likeness of anyone.`;
    case "screenshot":
      return `Screenshot published by the registry under this persona${said}, kept as a record of the profile it shows.`;
  }
  if (decision.face === false) {
    return `Screenshot published by the registry under this persona${said}, kept as a record of the profile it shows.`;
  }
  return (
    `Photograph published by the registry under this persona${said}. It shows whoever appeared under this identity, ` +
    "which is not necessarily the person whose details the identity was assembled from — these operations routinely " +
    "build a persona around a real, uninvolved person."
  );
}

/**
 * The { photo, photos } a registry persona carries: every image with a `use`
 * decision whose mirrored file is on disk, in the registry's order. The first
 * face is `photo` (the card portrait); the rest are `photos`.
 */
function registryPhotos(persona, decisions = loadDecisions()) {
  const all = [];
  for (const image of persona.images || []) {
    const d = decisions[image.path];
    if (!d || !d.use || !d.file) continue;
    if (!fs.existsSync(path.join(SITE_SRC, d.file))) continue;
    // The registry lists some images twice under one persona.
    if (all.some((ph) => ph.file === d.file)) continue;
    all.push({ file: d.file, post: 0, caption: photoCaption(image, d), ...(d.face === false ? { face: false } : {}) });
  }
  const primary = all.find((ph) => ph.face !== false) || null;
  return { photo: primary, photos: all.filter((ph) => ph !== primary) };
}

/** The registry's files[] (CVs as PDF) this site mirrors, in the registry's order. */
function registryAttachments(persona, attachments = loadAttachments()) {
  const out = [];
  for (const f of persona.files || []) {
    const a = attachments[f.path];
    if (!a || !fs.existsSync(path.join(SITE_SRC, a.file))) continue;
    out.push({ file: a.file, title: f.name || a.name, description: f.short_description || a.description || "", bytes: a.bytes, post: 0 });
  }
  return out;
}

function loadAttachments() {
  return JSON.parse(fs.readFileSync(DECISIONS, "utf8")).attachments || {};
}

module.exports = { loadDecisions, loadAttachments, photoCaption, registryPhotos, registryAttachments };
