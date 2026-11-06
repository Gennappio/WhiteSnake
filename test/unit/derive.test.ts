import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheEquals, deriveProcedure, ownerFor, replay, type ProcedureEvent } from "../../src/lifecycle/derive.js";
import { parseNode, type Procedure } from "../../src/schema/nodes.js";
import { loadStore } from "../../src/store/files.js";
import { tempToy } from "../helpers.js";

const T = (minute: number): string => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

function procedure(): Procedure {
  const r = parseNode({ id: "proc_abcdefghjkmn", type: "procedure", title: "t", created: T(5), created_by: "test", resolution: "code", entrypoint: "x.py", caused_by: null });
  assert.equal(r.ok, true);
  return (r as { node: Procedure }).node;
}

const shown = (minute: number, source: string): ProcedureEvent => ({ kind: "shown", at: T(minute), source, caused_by: "turn_x", reason: `${source} shown`, actor: null, counts: true });
const corrected = (minute: number, source: string, counts = true): ProcedureEvent => ({ kind: "corrected", at: T(minute), source, caused_by: "turn_y", reason: "wrong", actor: counts ? "human:researcher" : "human:researcher@other", counts });
const explicit = (kind: ProcedureEvent["kind"], minute: number, source: string): ProcedureEvent => ({ kind, at: T(minute), source, caused_by: source, reason: `${kind} by decision`, actor: "agent", counts: true });

test("replay promotes at the threshold, suspends on a counting correction and resets on reinstate", () => {
  const p = procedure();
  const d = replay(p, [shown(10, "dec_a"), shown(11, "dec_b"), shown(12, "dec_c"), corrected(13, "ev1"), explicit("reinstate", 14, "dec_r"), shown(15, "dec_d")], 3);
  assert.equal(d.state, "provisional");
  assert.deepEqual(d.counters, { shown_uses: 1, corrections: 0 });
  assert.deepEqual(d.history.map((h) => h.to), ["provisional", "trusted", "suspended", "provisional"]);
  assert.equal(d.history[0]!.at, T(5), "creation is the first entry, at the procedure's creation");
  assert.equal(d.history[1]!.caused_by, "turn_x", "a promotion cites the turn of the decision that triggered it");
  assert.equal(d.history[3]!.caused_by, "dec_r", "an explicit transition cites its choice decision");
  assert.deepEqual(d.warnings, []);
});

test("a correction by another context's researcher is not a transition here", () => {
  const p = procedure();
  const d = replay(p, [shown(10, "dec_a"), corrected(11, "ev1", false), shown(12, "dec_b"), shown(13, "dec_c")], 3);
  assert.equal(d.state, "trusted");
  assert.deepEqual(d.counters, { shown_uses: 3, corrections: 0 });
});

test("events are replayed in time order, creation first; ties go shown, corrected, explicit, then by source", () => {
  const p = procedure();
  // Shown before the procedure's creation time still counts: the toy fixture is exactly that case.
  const early = replay(p, [shown(1, "dec_a"), shown(2, "dec_b"), shown(3, "dec_c")], 3);
  assert.equal(early.state, "trusted");
  // Same moment: the show is counted before the correction suspends.
  const tie = replay(p, [corrected(10, "ev1"), shown(10, "dec_a")], 3);
  assert.deepEqual(tie.counters, { shown_uses: 1, corrections: 1 });
  assert.equal(tie.state, "suspended");
  // File order does not matter.
  const forward = replay(p, [shown(10, "dec_a"), corrected(11, "ev1"), shown(12, "dec_b")], 3);
  const backward = replay(p, [shown(12, "dec_b"), corrected(11, "ev1"), shown(10, "dec_a")], 3);
  assert.deepEqual(forward.counters, backward.counters);
  assert.deepEqual(forward.history, backward.history);
  assert.deepEqual(forward.counters, { shown_uses: 1, corrections: 1 });
});

test("a transition the rules do not admit is reported and not applied", () => {
  const p = procedure();
  const d = replay(p, [corrected(10, "ev1"), explicit("retire", 11, "dec_t"), explicit("reinstate", 12, "dec_r"), explicit("reinstate", 13, "dec_s")], 3);
  assert.equal(d.state, "provisional");
  assert.deepEqual(d.history.map((h) => h.to), ["provisional", "suspended", "provisional"]);
  assert.deepEqual(d.warnings.map((w) => w.decision), ["dec_t", "dec_s"]);
  assert.match(d.warnings[0]!.message, /to retired, which the rules do not admit from suspended/);
  const superseded = replay(p, [explicit("supersede", 10, "dec_x"), shown(11, "dec_a"), explicit("reinstate", 12, "dec_r")], 3);
  assert.deepEqual(superseded.history.map((h) => h.to), ["provisional", "superseded", "provisional"]);
  assert.equal(superseded.counters.shown_uses, 0, "nothing counts while superseded");
});

test("the toy store's cache equals its derivation: two shown P01 decisions produced with the procedure", () => {
  const { dir, cleanup } = tempToy();
  try {
    const store = loadStore(dir);
    const d = deriveProcedure(store, "proc_tablecount01");
    assert.deepEqual(d.counters, { shown_uses: 2, corrections: 0 });
    assert.equal(d.state, "provisional");
    assert.deepEqual(cacheEquals(store.nodes.get("proc_tablecount01") as Procedure, d), { state: true, counters: true, history: true });
  } finally {
    cleanup();
  }
});

test("the owner of a context is the store's researcher on main and the parent's researcher on its branch", () => {
  assert.equal(ownerFor(null), "human:researcher");
  assert.equal(ownerFor("main"), "human:researcher");
  assert.equal(ownerFor("parent/alpha"), "human:researcher@alpha");
});
