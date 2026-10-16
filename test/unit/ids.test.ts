import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidId, newId, sessionIdFor, turnIdFor, typeOfId } from "../../src/schema/ids.js";

test("authored ids have a type prefix and twelve characters", () => {
  const id = newId("decision");
  assert.match(id, /^dec_[0-9a-z]{12}$/);
  assert.equal(typeOfId(id), "decision");
  assert.ok(isValidId(id, "decision"));
  assert.ok(!isValidId(id, "evidence"));
});

test("session and turn ids derive from native ids deterministically", () => {
  assert.equal(sessionIdFor("claude", "AB12-cd34"), "ses_claude_ab12cd34");
  assert.equal(turnIdFor("claude", "AB12-cd34", 7), "turn_claude_ab12cd34_0007");
  assert.ok(isValidId("turn_claude_ab12cd34_0007", "turn"));
  assert.ok(!isValidId("turn_claude_ab12cd34_7"));
  assert.throws(() => newId("turn"));
});

test("malformed ids are rejected", () => {
  assert.ok(!isValidId("dec_short"));
  assert.ok(!isValidId("nope_abcdefghijkl"));
  assert.ok(!isValidId("dec_ABCDEFGHIJKL"));
});
