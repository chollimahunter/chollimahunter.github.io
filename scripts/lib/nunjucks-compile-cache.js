/**
 * nunjucks-compile-cache.js — compile each Nunjucks template once per build
 * ==========================================================================
 * Eleventy 3.1 leaves Nunjucks out of its own compile cache (its engine says
 * it relies on Nunjucks' cache instead), but its compile() builds a fresh
 * nunjucks.Template from the source string every time. A paginated template
 * is compiled again for every page it writes, so the 29,600 indicator pages
 * recompiled indicator-page.njk, and the computed title, description and
 * permalink strings, once each: a CPU profile of 18 November 2026 put 158 of
 * the build's 257 seconds in the Nunjucks lexer, parser and compiler.
 *
 * Template._compile() already skips compiling when `tmplProps` is set, which
 * is how precompiled templates load. This fills `tmplProps` from a cache keyed
 * on the template's path and source, so identical source compiles once. The
 * compiled functions hold no per-template state, the same assumption
 * precompilation makes. The key includes the full source, so an edited file
 * under `eleventy --serve` compiles afresh; clear() drops the cache between
 * builds so a long-running server does not hold every past version.
 *
 * Nunjucks is resolved from Eleventy's own location so the patch reaches the
 * copy Eleventy renders with.
 */
"use strict";

const path = require("path");

const from = { paths: [path.dirname(require.resolve("@11ty/eleventy"))] };
const nunjucks = require(require.resolve("nunjucks", from));
const compiler = require(require.resolve("nunjucks/src/compiler", from));

const cache = new Map();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const original = nunjucks.Template.prototype._compile;
  nunjucks.Template.prototype._compile = function () {
    if (!this.tmplProps && typeof this.tmplStr === "string") {
      const key = `${this.path || ""}\0${this.tmplStr}`;
      let props = cache.get(key);
      if (!props) {
        const source = compiler.compile(this.tmplStr, this.env.asyncFilters, this.env.extensionsList, this.path, this.env.opts);
        props = new Function(source)(); // eslint-disable-line no-new-func
        cache.set(key, props);
      }
      this.tmplProps = props;
    }
    return original.call(this);
  };
}

function clear() {
  cache.clear();
}

module.exports = { install, clear };
