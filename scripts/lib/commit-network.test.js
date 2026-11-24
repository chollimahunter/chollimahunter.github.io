const test = require("node:test");
const assert = require("node:assert");
const { fold, commitFrom, isOwnName, network, leads } = require("./commit-network.js");

test("fold folds Gmail dots and plus tags only", () => {
  assert.strictEqual(fold("A.B+x@googlemail.com"), "ab@gmail.com");
  assert.strictEqual(fold("a.b@outlook.com"), "a.b@outlook.com");
});

test("commitFrom keeps a real address and drops a noreply one, keeping its handle", () => {
  const item = (email) => ({ sha: "0123456789abcdef", repository: { full_name: "o/r" }, commit: { author: { name: "N", email, date: "2022-04-10T00:00:00Z" } } });
  assert.deepStrictEqual(commitFrom(item("X@Gmail.com"), "author"), { repo: "o/r", sha: "0123456789ab", date: "2022-04-10", name: "N", email: "x@gmail.com", noreply_login: null, via: "author" });
  const nr = commitFrom(item("69390291+bestsilvertiger@users.noreply.github.com"), "noreply");
  assert.strictEqual(nr.email, null);
  assert.strictEqual(nr.noreply_login, "bestsilvertiger");
});

test("isOwnName ignores the login, its old handle, and generic names", () => {
  assert.ok(isOwnName("Gigi-0500", "gigi0500"));
  assert.ok(isOwnName("BestSilverTiger", "gigi0500", "bestsilvertiger"));
  assert.ok(isOwnName("root", "x"));
  assert.ok(!isOwnName("wstar0209", "gigi0500", "bestsilvertiger"));
});

test("network and leads find shared repositories, second handles and unlisted addresses", () => {
  const c = (repo, name, email = null, noreply_login = null) => ({ repo, sha: repo + name, date: "2022-01-01", name, email, noreply_login, via: "author" });
  const accounts = {
    a: { login: "alpha1", commits: [c("team/x", "alpha1"), c("alpha1/own", "wstar0209"), c("client/app", "Alpha", "own@x.com")] },
    b: { login: "beta2", commits: [c("team/x", "beta2"), c("team/y", "Shared Name"), c("beta2/z", "beta2", "listed@gmail.com")] },
    c: { login: "gamma3", commits: [c("other/q", "Shared Name")] },
  };
  const l = leads(network(accounts, new Set(["listed@gmail.com"])));
  assert.deepStrictEqual(l.owners.map((g) => [g.owner, g.seeds.length]), [["team", 2]]);
  assert.deepStrictEqual(l.names.map((g) => g.name).sort(), ["Shared Name", "wstar0209"]);
  assert.deepStrictEqual(l.emails.map((g) => g.email), ["own@x.com"]);
});
