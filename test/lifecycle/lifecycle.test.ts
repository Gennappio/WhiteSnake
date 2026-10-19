import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const SESSION = "22222222-3333-4444-5555-666666666666";
const TURN = "turn_claude_22222222333344445555666666666666_0001";

function startTurn(dir: string, prompt: string): void {
  const r = runCli(["hooks", "run", "UserPromptSubmit"], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: SESSION, hook_event_name: "UserPromptSubmit", prompt }) });
  assert.equal(r.status, 0, r.stderr);
}

function annotate(dir: string, unit: string, field: string, value: number, warrant: string, usesProc = true): { ep: string; dec: string } {
  const ep = runCli(["--json", "episode", "open", `${unit} ${field}`, "--resolution", usesProc ? "code" : "agent", ...(usesProc ? ["--uses", "proc_tablecount01", warrant] : ["--uses", warrant])], { cwd: dir });
  assert.equal(ep.status, 0, ep.stdout);
  const epId = (ep.json as { id: string }).id;
  const ev = runCli(["--json", "add", "evidence", "--json-in", JSON.stringify({ title: `${unit} table`, kind: "excerpt", locator: { artifact: "art_p02b8n4p0r5y" }, produced_by: epId }), "--body", `| ${unit} | ${value} |`], { cwd: dir });
  const evId = (ev.json as { id: string }).id;
  const dec = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: `${unit} ${field}`, kind: "annotation", status: "active", claim: `${value}`, qualifier: { confidence: 0.9 }, fragility: "mechanical", target: { unit, field, value }, data: [evId], warrant: [warrant], depends_on: usesProc ? ["proc_tablecount01"] : [], produced_by: epId })], { cwd: dir });
  assert.equal(dec.status, 0, dec.stdout);
  const decId = (dec.json as { id: string }).id;
  const close = runCli(["--json", "episode", "close", epId, "--produces", evId, decId], { cwd: dir });
  assert.equal(close.status, 0, close.stdout);
  return { ep: epId, dec: decId };
}

test("shown uses promote a provisional procedure to trusted at the configured threshold", () => {
  const { dir, cleanup } = tempToy();
  try {
    startTurn(dir, "Annotate P02 and P03");
    const a = annotate(dir, "P02", "n_randomized_total", 84, "dec_crit0random2");
    const b = annotate(dir, "P03", "n_randomized_total", 150, "dec_crit0random2");
    const first = runCli(["--json", "shown", a.dec], { cwd: dir });
    assert.equal(first.status, 0, first.stdout);
    assert.deepEqual((first.json as { promoted: string[] }).promoted, []);
    const procAfterOne = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number } };
    assert.equal(procAfterOne.counters.shown_uses, 2);
    assert.equal(procAfterOne.state, "provisional");
    const second = runCli(["--json", "shown", b.dec], { cwd: dir });
    assert.deepEqual((second.json as { promoted: string[] }).promoted, ["proc_tablecount01"]);
    const proc = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; history: { to: string; caused_by: string }[] };
    assert.equal(proc.state, "trusted");
    assert.equal(proc.history[proc.history.length - 1]?.to, "trusted");
    assert.equal(proc.history[proc.history.length - 1]?.caused_by, TURN);
    const again = runCli(["--json", "shown", a.dec], { cwd: dir }).json as { already: string[] };
    assert.deepEqual(again.already, [a.dec]);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    const res = runCli(["--json", "resolve", "--unit", "P09", "--field", "n_randomized_total"], { cwd: dir }).json as { mode: string };
    assert.equal(res.mode, "code");
    const cached = runCli(["--json", "resolve", "--unit", "P01", "--field", "n_analyzed_total"], { cwd: dir }).json as { mode: string; decision: string };
    assert.equal(cached.mode, "cached");
    assert.equal(cached.decision, "dec_p01nanal0000");
  } finally {
    cleanup();
  }
});

test("a correction suspends the procedure, supersedes the decision when a value is given, and flags dependents", () => {
  const { dir, cleanup } = tempToy();
  try {
    startTurn(dir, "Annotate P02");
    const a = annotate(dir, "P02", "n_analyzed_total", 80, "dec_crit0analyz1");
    runCli(["shown", a.dec], { cwd: dir });
    const corr = runCli(["--json", "correct", a.dec, "--reason", "count analysed per protocol here", "--value", "78"], { cwd: dir });
    assert.equal(corr.status, 0, corr.stdout);
    const result = corr.json as { replacement: string | null; suspended: string[]; needs_review: string[] };
    assert.ok(result.replacement);
    assert.deepEqual(result.suspended, ["proc_tablecount01"]);
    const old = runCli(["--json", "get", a.dec], { cwd: dir }).json as { status: string };
    assert.equal(old.status, "superseded");
    const rep = runCli(["--json", "get", result.replacement!], { cwd: dir }).json as { status: string; target: { value: number }; supersedes: string[]; created_by: string };
    assert.equal(rep.status, "active");
    assert.equal(rep.target.value, 78);
    assert.deepEqual(rep.supersedes, [a.dec]);
    const proc = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { corrections: number } };
    assert.equal(proc.state, "suspended");
    assert.equal(proc.counters.corrections, 1);
    const ep = runCli(["--json", "get", a.ep], { cwd: dir }).json as { outcome: string };
    assert.equal(ep.outcome, "corrected");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);

    // Correcting a criterion flags every annotation that cites it, including the fixture's P01 decision.
    const crit = runCli(["--json", "correct", "dec_crit0analyz1", "--reason", "we now count randomised"], { cwd: dir }).json as { needs_review: string[]; suspended: string[] };
    assert.ok(crit.needs_review.includes("dec_p01nanal0000"));
    assert.ok(crit.needs_review.includes(result.replacement!));
    assert.deepEqual(crit.suspended, []);
    const k = runCli(["--json", "kpi"], { cwd: dir }).json as { procedures: { by_state: Record<string, number> }; decisions: { by_status: Record<string, number> }; transitions: { to: string }[] };
    assert.equal(k.procedures.by_state["suspended"], 1);
    assert.ok((k.decisions.by_status["needs_review"] ?? 0) >= 2);
    assert.ok(k.transitions.some((t) => t.to === "suspended"));
    const reinstated = runCli(["--json", "procedure", "reinstate", "proc_tablecount01", "--reason", "fixed the parser"], { cwd: dir }).json as { state: string; counters: { shown_uses: number } };
    assert.equal(reinstated.state, "provisional");
    assert.equal(reinstated.counters.shown_uses, 0);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("the Stop hook marks the decisions listed in the agent's final message as shown", () => {
  const { dir, cleanup } = tempToy();
  try {
    startTurn(dir, "Annotate P02");
    const a = annotate(dir, "P02", "n_randomized_total", 84, "dec_crit0random2");
    const transcript = `${dir}/fake-transcript.jsonl`;
    const lines = [
      { type: "user", sessionId: SESSION, uuid: "u1", timestamp: "2026-10-16T10:00:00.000Z", cwd: dir, message: { role: "user", content: "Annotate P02" } },
      { type: "assistant", sessionId: SESSION, uuid: "a1", timestamp: "2026-10-16T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: `Done. Created ${a.dec} for P02.` }] } },
    ];
    writeFileSync(transcript, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const stop = runCli(["hooks", "run", "Stop"], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: SESSION, hook_event_name: "Stop", transcript_path: transcript }) });
    assert.equal(stop.status, 0, stop.stderr);
    const dec = runCli(["--json", "get", a.dec], { cwd: dir }).json as { shown_at: string[] };
    assert.deepEqual(dec.shown_at, [TURN]);
  } finally {
    cleanup();
  }
});

test("render writes a self-contained review page that names every decision and the KPI tiles", () => {
  const { dir, cleanup } = tempToy();
  try {
    const r = runCli(["--json", "render"], { cwd: dir });
    assert.equal(r.status, 0, r.stdout);
    const html = readFileSync(join(dir, "review.html"), "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /resolved without an agent/);
    assert.match(html, /Toy trial annotation store/);
    for (const id of ["dec_p01nanal0000", "dec_p01nrand0000", "dec_p01outcm0000", "dec_crit0analyz1", "proc_tablecount01", "q_figonly00001"]) assert.ok(html.includes(id), `${id} missing from review page`);
    assert.ok(!/<script src=/.test(html), "no external scripts");
    assert.match(html, /turn_claude_toyseed0001_0002/);
  } finally {
    cleanup();
  }
});

test("shown uses are not counted for suspended or retired procedures", () => {
  const retiredCase = tempToy();
  const suspendedCase = tempToy();
  try {
    // Retired: promote through three shown results, retire, then show a fourth result produced with it.
    let dir = retiredCase.dir;
    startTurn(dir, "Annotate P02, P03 and P04");
    const a = annotate(dir, "P02", "n_randomized_total", 84, "dec_crit0random2");
    const b = annotate(dir, "P03", "n_randomized_total", 150, "dec_crit0random2");
    const c = annotate(dir, "P04", "n_randomized_total", 150, "dec_crit0random2");
    runCli(["shown", a.dec, b.dec], { cwd: dir });
    assert.equal((runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string }).state, "trusted");
    const retired = runCli(["--json", "procedure", "retire", "proc_tablecount01", "--reason", "the model does it alone"], { cwd: dir });
    assert.equal(retired.status, 0, retired.stdout);
    const shown = runCli(["--json", "shown", c.dec], { cwd: dir });
    assert.deepEqual((shown.json as { shown: string[] }).shown, [c.dec]);
    const afterRetired = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number } };
    assert.equal(afterRetired.state, "retired");
    assert.equal(afterRetired.counters.shown_uses, 3);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);

    // Suspended: a correction suspends the procedure; a result shown afterwards adds nothing.
    dir = suspendedCase.dir;
    startTurn(dir, "Annotate P02 and P03");
    const d = annotate(dir, "P02", "n_randomized_total", 84, "dec_crit0random2");
    const e = annotate(dir, "P03", "n_randomized_total", 150, "dec_crit0random2");
    const corr = runCli(["--json", "correct", d.dec, "--reason", "wrong arm counted"], { cwd: dir });
    assert.equal(corr.status, 0, corr.stdout);
    assert.deepEqual((corr.json as { suspended: string[] }).suspended, ["proc_tablecount01"]);
    runCli(["shown", e.dec], { cwd: dir });
    const afterSuspended = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number } };
    assert.equal(afterSuspended.state, "suspended");
    assert.equal(afterSuspended.counters.shown_uses, 1);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    retiredCase.cleanup();
    suspendedCase.cleanup();
  }
});
