// True when private, maintainer-only pages are being built: under
// `npm run serve`, or with ELEVENTY_PRIVATE_PAGES set. A production build
// (`npm run build`, which the deploy workflow runs) is false, so a template
// that checks this cannot publish a private page or a link to one. Same gate as
// src/remote-workers/held-back/held-back.11tydata.js.
module.exports = () => {
  const mode = process.env.ELEVENTY_RUN_MODE;
  return mode === "serve" || mode === "watch" || Boolean(process.env.ELEVENTY_PRIVATE_PAGES);
};
