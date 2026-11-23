const test = require("node:test");
const assert = require("node:assert");
const { seal, falsePositiveScrubber } = require("./private-data.js");

const sealed = new Set(["someone@example.com", "someone2@gmail.com","https://github.com/realco", "https://t.me/shop"].map(seal));
const scrub = falsePositiveScrubber((value) => sealed.has(seal(value)));

test("falsePositiveScrubber withholds a quoted false positive and nothing else", () => {
  const cases = [
    ["identity 2 someone@example.com email insider", "identity 2 [withheld] email insider"],
    ["Contact: Someone@Example.com.", "Contact: [withheld]."],
    ["see github.com/realco and github.com/realcoder", "see [withheld] and github.com/realcoder"],
    ["(https://t.me/shop/)", "([withheld])"],
    ["Github: louistalent realco TopDev", "Github: louistalent [withheld] TopDev"],
    ["shopping realcoder", "shopping realcoder"],
    ["…github.com/realco - next", "…[withheld] - next"],
    ["shared@x.com someone@example.…", "shared@x.com someone@example.…"],
    ["guang@gmail.com someone2@gmail.…", "guang@gmail.com [withheld].…"],
    ["operator@example.com stays", "operator@example.com stays"],
    ["", ""],
  ];
  for (const [input, expected] of cases) assert.strictEqual(scrub(input), expected, input);
  assert.strictEqual(scrub(undefined), undefined);
});
