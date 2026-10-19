import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const SESSION = "33333333-4444-5555-6666-777777777777";
const hook = (dir: string, event: string, payload: Record<string, unknown> = {}) =>
  runCli(["hooks", "run", event], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: SESSION, hook_event_name: event, ...payload }) });

test("the write journal reports files under knowledge/ changed outside the CLI, by result and once, however they were written", () => {
  const { dir, cleanup } = tempToy();
  try {
    // Session start takes the baseline; a Stop with nothing changed reports nothing.
    assert.equal(hook(dir, "SessionStart", { source: "startup" }).status, 0);
    assert.ok(existsSync(join(dir, ".whitesnake", "knowledge-snapshot.json")));
    assert.equal(hook(dir, "Stop").stdout.trim(), "");

    // CLI writes leave receipts: the turn node, a new question, an updated decision.
    hook(dir, "UserPromptSubmit", { prompt: "Annotate" });
    const q = runCli(["--json", "add", "question", "--json-in", JSON.stringify({ title: "Figure-only counts?", why: "P05 reports counts in a figure" })], { cwd: dir });
    assert.equal(q.status, 0, q.stdout);
    const qid = (q.json as { id: string }).id;
    assert.equal(runCli(["set", "dec_p01outcm0000", "--json-in", JSON.stringify({ qualifier: { confidence: 0.9 } })], { cwd: dir }).status, 0);
    const receipts = readFileSync(join(dir, ".whitesnake", "writes.jsonl"), "utf8");
    assert.match(receipts, new RegExp(`"op":"write","path":"knowledge/questions/${qid}.md"`));
    assert.match(receipts, /"path":"knowledge\/decisions\/dec_p01outcm0000\.md"/);

    // Hand writes, the way a python one-liner, a cd plus redirect or a git checkout would do them.
    writeFileSync(join(dir, "knowledge", "decisions", "dec_handwritten0.md"), "---\nid: dec_handwritten0\ntype: decision\n---\n");
    const edited = join(dir, "knowledge", "decisions", "dec_p01nanal0000.md");
    writeFileSync(edited, readFileSync(edited, "utf8").replace("value: 115", "value: 116"));
    rmSync(join(dir, "knowledge", "evidence", "ev_p01outcome00.md"));

    const stop = hook(dir, "Stop");
    assert.equal(stop.status, 0, stop.stderr);
    const message = (JSON.parse(stop.stdout) as { systemMessage: string }).systemMessage;
    assert.match(message, /3 file\(s\) under knowledge\/ changed outside the CLI/);
    assert.match(message, /knowledge\/decisions\/dec_handwritten0\.md added/);
    assert.match(message, /knowledge\/decisions\/dec_p01nanal0000\.md modified/);
    assert.match(message, /knowledge\/evidence\/ev_p01outcome00\.md deleted/);
    assert.doesNotMatch(message, new RegExp(qid));
    assert.doesNotMatch(message, /dec_p01outcm0000/);
    const stops = readFileSync(join(dir, ".whitesnake", "hooks.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; direct_writes?: string[] })
      .filter((e) => e.event === "Stop");
    assert.equal(stops.length, 2);
    assert.deepEqual(stops[0]!.direct_writes, []);
    assert.equal(stops[1]!.direct_writes!.length, 3);

    // The check moved the baseline: the same files are not reported a second time.
    assert.doesNotMatch(hook(dir, "Stop").stdout, /changed outside the CLI/);
  } finally {
    cleanup();
  }
});
