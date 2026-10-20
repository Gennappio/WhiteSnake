import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOutput, sameValue } from "../../src/lifecycle/regression.js";

test("regression comparisons respect types: an absent value never equals zero", () => {
  assert.equal(sameValue(null, 0), false);
  assert.equal(sameValue(0, null), false);
  assert.equal(sameValue(undefined, 0), false);
  assert.equal(sameValue("", 0), false);
  assert.equal(sameValue(false, 0), false);
  assert.equal(sameValue(true, 1), false);
  assert.equal(sameValue("abc", 0), false);
  assert.equal(sameValue({ total: 120 }, 120), false);
  assert.equal(sameValue(null, null), true);
  assert.equal(sameValue(120, 120), true);
  assert.equal(sameValue("120", 120), true, "command output is text: a numeric string equals its number");
  assert.equal(sameValue(120, "120.0"), true);
  assert.equal(sameValue(true, true), true);
  assert.equal(sameValue(" Pain Intensity ", "pain intensity"), true, "text stays lenient on case and spacing");
  assert.equal(sameValue({ total: 120 }, { total: 120 }), true);
  assert.equal(sameValue(parseOutput(""), 0), false, "an empty output is not zero");
  assert.equal(sameValue(parseOutput("120\n"), 120), true);
});
