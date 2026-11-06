import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEdges } from "../../src/schema/edges.js";
import { parseNode } from "../../src/schema/nodes.js";

const baseDecision = {
  id: "dec_abcdefghjkmn",
  type: "decision",
  title: "t",
  created: "2026-10-01T00:00:00.000Z",
  created_by: "test",
  kind: "annotation",
  claim: "c",
  qualifier: { confidence: 0.5 },
  fragility: "mechanical",
};

test("annotation decisions require a target", () => {
  const r = parseNode(baseDecision);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.path === "target"));
  const ok = parseNode({ ...baseDecision, target: { unit: "P01", field: "f", value: 1 } });
  assert.equal(ok.ok, true);
});

test("unknown fields are rejected (strict schemas catch misdirected edges)", () => {
  const r = parseNode({ ...baseDecision, target: { unit: "P01", field: "f", value: 1 }, supports: ["ev_x"] });
  assert.equal(r.ok, false);
});

test("defaults are applied and edges extracted with canonical rels", () => {
  const r = parseNode({ ...baseDecision, target: { unit: "P01", field: "f", value: 1 }, data: ["ev_aaaaaaaaaaaa"], warrant: ["dec_bbbbbbbbbbbb"], rebuttal: { evidence: ["ev_cccccccccccc"] } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.node.type === "decision" && r.node.status, "proposed");
  const edges = extractEdges(r.node).map((e) => `${e.rel}:${e.dst}`).sort();
  assert.deepEqual(edges, ["data:ev_aaaaaaaaaaaa", "rebuttal:ev_cccccccccccc", "warrant:dec_bbbbbbbbbbbb"]);
});

test("remote children become unvalidated remote edges", () => {
  const r = parseNode({ id: "ep_abcdefghjkmn", type: "episode", title: "t", created: "2026-10-01T00:00:00.000Z", created_by: "test", resolution: "agent", started: "2026-10-01T00:00:00.000Z", children: ["ep_bbbbbbbbbbbb", { store: "child", id: "ep_cccccccccccc" }] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const edges = extractEdges(r.node).map((e) => `${e.rel}:${e.dst}`).sort();
  assert.deepEqual(edges, ["children:ep_bbbbbbbbbbbb", "children_remote:child:ep_cccccccccccc"]);
});

test("remote references are accepted in data, backing, depends_on and cites, and rely like local ones", async () => {
  const { edgeSpec } = await import("../../src/schema/edges.js");
  const { parseRef } = await import("../../src/schema/nodes.js");
  const r = parseNode({ ...baseDecision, target: { unit: "P01", field: "f", value: 1 }, data: ["ev_aaaaaaaaaaaa", { store: "child", id: "ev_bbbbbbbbbbbb", commit: "abc123" }], depends_on: [{ store: "child", id: "dec_cccccccccccc" }] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const edges = extractEdges(r.node).map((e) => `${e.rel}:${e.dst}`).sort();
  assert.deepEqual(edges, ["data:ev_aaaaaaaaaaaa", "data_remote:child:ev_bbbbbbbbbbbb", "depends_on_remote:child:dec_cccccccccccc"]);
  assert.equal(r.node.type === "decision" && (r.node.depends_on[0] as { commit: string | null }).commit, null, "commit defaults to null");
  assert.equal(edgeSpec("decision", "depends_on_remote")?.relies, true);
  assert.equal(edgeSpec("decision", "data_remote")?.relies, true);
  assert.equal(edgeSpec("episode", "children_remote")?.relies, false);
  assert.equal(edgeSpec("decision", "nonsense_remote"), undefined);
  const ev = parseNode({ id: "ev_abcdefghjkmn", type: "evidence", title: "t", created: "2026-10-01T00:00:00.000Z", created_by: "test", kind: "execution", locator: { path: "x" }, hash: "a".repeat(64), cites: [{ store: "child", id: "dec_cccccccccccc", commit: "deadbeef" }] });
  assert.equal(ev.ok, true);
  if (ev.ok) assert.deepEqual(extractEdges(ev.node).map((e) => `${e.rel}:${e.dst}`), ["cites_remote:child:dec_cccccccccccc"]);
  const warrant = parseNode({ ...baseDecision, target: { unit: "P01", field: "f", value: 1 }, warrant: [{ store: "child", id: "dec_cccccccccccc" }] });
  assert.equal(warrant.ok, false, "a warrant is a criterion of this store");
  assert.deepEqual(parseRef("child:dec_cccccccccccc@deadbeef"), { store: "child", id: "dec_cccccccccccc", commit: "deadbeef" });
  assert.deepEqual(parseRef("child:dec_cccccccccccc"), { store: "child", id: "dec_cccccccccccc", commit: null });
  assert.equal(parseRef("dec_cccccccccccc"), "dec_cccccccccccc");
  assert.equal(parseRef("P01/n_analyzed_total"), "P01/n_analyzed_total");
});
