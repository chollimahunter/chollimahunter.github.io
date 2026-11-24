const test = require("node:test");
const assert = require("node:assert");
const { githubFrom, readPackument, namesFromSearch, leads } = require("./npm-pivot.js");

test("githubFrom reads owner and repository from the usual URL shapes", () => {
  assert.deepStrictEqual(githubFrom("git+https://github.com/Owner-1/repo.name.git"), { owner: "Owner-1", repo: "Owner-1/repo.name" });
  assert.deepStrictEqual(githubFrom("git@github.com:owner/repo.git"), { owner: "owner", repo: "owner/repo" });
  assert.deepStrictEqual(githubFrom("https://github.com/owner#readme"), { owner: "owner", repo: null });
  assert.strictEqual(githubFrom("https://gitlab.com/x/y"), null);
});

test("readPackument gathers people, dependencies and GitHub links, and skips npm staff", () => {
  const doc = {
    name: "web-http-errors",
    description: "Small HTTP error factory",
    maintainers: [{ name: "Op1", email: "Op1@Hotmail.com" }, { name: "npm", email: "npm@npmjs.com" }],
    repository: { url: "git+https://github.com/opgh/web-http-errors.git" },
    time: { created: "2026-04-21T07:00:00Z" },
    versions: {
      "1.0.0": { version: "1.0.0", _npmUser: { name: "op1", email: "op1@hotmail.com" }, dependencies: { "prettier-resolver": "^1" } },
      "1.1.0": { version: "1.1.0", _npmUser: { name: "op2", email: "op2@gmail.com" }, dependencies: { chalk: "^5" }, author: { name: "X", email: "x@y.z" } },
    },
  };
  const p = readPackument(doc);
  assert.strictEqual(p.holding, false);
  assert.deepStrictEqual(p.dependencies, ["chalk", "prettier-resolver"]);
  assert.deepStrictEqual(p.github, [{ owner: "opgh", repo: "opgh/web-http-errors" }]);
  assert.deepStrictEqual(p.people.map((x) => [x.name, x.emails.join(), x.roles.join()]), [["op1", "op1@hotmail.com", "maintainer,publisher"], ["op2", "op2@gmail.com", "publisher"], [null, "x@y.z", "author"]]);
});

test("a security holding package reads as holding with nobody behind it", () => {
  const p = readPackument({ name: "bn-eslint.js", description: "security holding package", maintainers: [{ name: "npm", email: "npm@npmjs.com" }], versions: { "0.0.1-security": { version: "0.0.1-security" } } });
  assert.strictEqual(p.holding, true);
  assert.deepStrictEqual(p.people, []);
});

test("leads keeps only what the index lacks, and low-download dependencies", () => {
  const data = {
    maintainers: { op1: { packages: ["web-http-errors", "safe-json-72"] } },
    packages: { "web-http-errors": readPackumentStub() },
    downloads: { "prettier-resolver": 40, chalk: 300000000, "loader-x": 12 },
  };
  const indexed = new Set(["web-http-errors", "prettier-resolver", "npm:op1", "op1@hotmail.com"]);
  const l = leads(data, indexed);
  assert.deepStrictEqual(l.packages.map((g) => g.name), ["safe-json-72"]);
  assert.deepStrictEqual(l.accounts.map((g) => [g.name, g.emails.join()]), [["op2", "op2@gmail.com"]]);
  assert.deepStrictEqual(l.emails.map((g) => g.email), ["op2@gmail.com"]);
  assert.deepStrictEqual(l.github.map((g) => g.repo), ["opgh/web-http-errors"]);
  assert.deepStrictEqual(l.dependencies.map((g) => g.name), ["loader-x"]);
  assert.deepStrictEqual(namesFromSearch({ objects: [{ package: { name: "a" } }, {}] }), ["a"]);
});

function readPackumentStub() {
  return {
    name: "web-http-errors",
    people: [{ name: "op1", emails: ["op1@hotmail.com"], roles: ["maintainer"] }, { name: "op2", emails: ["op2@gmail.com"], roles: ["publisher"] }],
    dependencies: ["chalk", "loader-x", "prettier-resolver"],
    github: [{ owner: "opgh", repo: "opgh/web-http-errors" }],
  };
}
