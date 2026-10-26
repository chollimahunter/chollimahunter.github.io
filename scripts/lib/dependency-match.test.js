const test = require("node:test");
const assert = require("node:assert");
const { parseBlobUrl, hasNpmDependency, hasPypiDependency, declaresPackage } = require("./dependency-match.js");

const pkg = (o) => JSON.stringify(o);

test("package.json: exact key in each dependency field", () => {
  for (const f of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.ok(hasNpmDependency(pkg({ [f]: { "config-log": "^1" } }), "config-log"), f);
  }
});

test("package.json: longer or scoped names do not match", () => {
  assert.ok(!hasNpmDependency(pkg({ devDependencies: { "eslint-config-log-level": "1" } }), "config-log"));
  assert.ok(!hasNpmDependency(pkg({ dependencies: { "case-sensitive-paths-webpack-plugin": "2" } }), "case-sensitive-paths"));
  assert.ok(!hasNpmDependency(pkg({ dependencies: { "@google-cloud/logging-winston": "6" } }), "logging-winston"));
  assert.ok(hasNpmDependency(pkg({ dependencies: { "@google-cloud/logging-winston": "6" } }), "@google-cloud/logging-winston"));
});

test("package.json: the package's own name or a script mention is not a dependency", () => {
  assert.ok(!hasNpmDependency(pkg({ name: "config-log", scripts: { x: "config-log" } }), "config-log"));
});

test("package-lock.json v2/v3: node_modules key, including nested", () => {
  assert.ok(hasNpmDependency(pkg({ packages: { "node_modules/foo": {} } }), "foo"));
  assert.ok(hasNpmDependency(pkg({ packages: { "node_modules/a/node_modules/foo": {} } }), "foo"));
  assert.ok(!hasNpmDependency(pkg({ packages: { "node_modules/eslint-foo": {}, "node_modules/@x/foo": {} } }), "foo"));
  assert.ok(hasNpmDependency(pkg({ packages: { "node_modules/@x/foo": {} } }), "@x/foo"));
});

test("package-lock.json v1: top-level and nested dependencies keys", () => {
  assert.ok(hasNpmDependency(pkg({ dependencies: { foo: { version: "1" } } }), "foo"));
  assert.ok(hasNpmDependency(pkg({ dependencies: { a: { dependencies: { foo: {} } } } }), "foo"));
  assert.ok(!hasNpmDependency(pkg({ dependencies: { "foo-bar": {} } }), "foo"));
});

test("non-JSON text falls back to a whole-name quoted key", () => {
  assert.ok(hasNpmDependency('{ "dependencies": { "foo": "1" },', "foo"));
  assert.ok(!hasNpmDependency('{ "dependencies": { "foo-bar": "1" },', "foo"));
});

test("requirements.txt: name before specifier or extras, case and - _ . equal", () => {
  assert.ok(hasPypiDependency("Foo_Bar==1.0\n", "foo-bar"));
  assert.ok(hasPypiDependency("foo.bar[extra]>=2 ; python_version>'3'\n", "Foo_Bar"));
  assert.ok(hasPypiDependency("# c\nfoo @ https://x/y.whl\n", "foo"));
  assert.ok(hasPypiDependency("git+https://x/y.git#egg=foo\n", "foo"));
  assert.ok(!hasPypiDependency("foobar==1\nfoo-bar-baz\n", "foo"));
  assert.ok(!hasPypiDependency("# foo\n-r foo\n--index-url https://foo\n", "foo"));
});

test("pyproject.toml: PEP 621 arrays and poetry tables", () => {
  assert.ok(hasPypiDependency('[project]\ndependencies = ["requests>=2", "Foo_Bar[x]==1"]\n', "foo-bar", "pyproject.toml"));
  assert.ok(hasPypiDependency('[tool.poetry.dependencies]\npython = "^3.9"\nfoo-bar = "^1"\n', "foo_bar", "sub/pyproject.toml"));
  assert.ok(!hasPypiDependency('[project]\nname = "foo"\ndependencies = ["foobar>=1"]\n', "foo", "pyproject.toml"));
});

test("declaresPackage dispatches by rule type and ignores others", () => {
  assert.strictEqual(declaresPackage("domain", "x.com", "x.com", "a"), null);
  assert.strictEqual(declaresPackage("npm_package", "foo", pkg({ dependencies: { foo: "1" } }), "package.json"), true);
});

test("parseBlobUrl", () => {
  assert.deepStrictEqual(parseBlobUrl("https://github.com/o/r/blob/abc123/a/b/package.json"), { owner: "o", repo: "r", ref: "abc123", path: "a/b/package.json" });
  assert.strictEqual(parseBlobUrl("https://example.com/x"), null);
});
