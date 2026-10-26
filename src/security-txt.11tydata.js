// Permalink for security-txt.njk. A YAML eleventyComputed string can only
// yield the string "false", which Eleventy treats as a path; only a real
// boolean false suppresses the file, so it has to be computed here.
module.exports = {
  eleventyComputed: {
    permalink(data) {
      const email = (data.site && data.site.businessEmail) || "";
      return email && !email.includes("TODO") ? "/.well-known/security.txt" : false;
    },
    // RFC 9116 wants Expires under a year out. Six months from the index
    // build date, falling back to the build clock if the index carries no
    // date, so the field is never emitted malformed.
    expires(data) {
      const generated = data.iocIndex && data.iocIndex.generated_at;
      const base = generated && !Number.isNaN(Date.parse(generated)) ? new Date(generated) : new Date();
      base.setUTCMonth(base.getUTCMonth() + 6);
      return base.toISOString();
    },
  },
};
