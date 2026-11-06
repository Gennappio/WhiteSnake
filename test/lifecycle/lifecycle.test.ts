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
    // The fixture already carries two shown P01 decisions produced with the procedure: the third promotes it.
    const first = runCli(["--json", "shown", a.dec], { cwd: dir });
    assert.equal(first.status, 0, first.stdout);
    assert.deepEqual((first.json as { promoted: string[] }).promoted, ["proc_tablecount01"]);
    const procAfterOne = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number }; history: { to: string; caused_by: string }[] };
    assert.equal(procAfterOne.counters.shown_uses, 3);
    assert.equal(procAfterOne.state, "trusted");
    assert.equal(procAfterOne.history[procAfterOne.history.length - 1]?.to, "trusted");
    assert.equal(procAfterOne.history[procAfterOne.history.length - 1]?.caused_by, TURN);
    const second = runCli(["--json", "shown", b.dec], { cwd: dir });
    assert.deepEqual((second.json as { promoted: string[] }).promoted, []);
    const proc = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number }; history: { to: string; caused_by: string }[] };
    assert.equal(proc.state, "trusted");
    assert.equal(proc.counters.shown_uses, 4);
    assert.deepEqual(proc.history.map((h) => h.to), ["provisional", "trusted"]);
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
    const old = runCli(["--json", "get", a.dec], { cwd: dir }).json as { status: string; corrections: { turn: string; event: string; actor: string; reason: string }[] };
    assert.equal(old.status, "superseded");
    assert.equal(old.corrections.length, 1, "the correction is an event on the decision");
    assert.equal(old.corrections[0]!.turn, TURN);
    assert.equal(old.corrections[0]!.actor, "human:researcher");
    assert.match(old.corrections[0]!.event, /^[0-9a-f]{64}$/);
    assert.equal(old.corrections[0]!.event, (corr.json as { event: string }).event);
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
    const reuse = runCli(["--json", "resolve", "--unit", "P02", "--field", "n_analyzed_total"], { cwd: dir }).json as { mode: string; decision: string };
    assert.equal(reuse.mode, "cached", "the researcher's replacement is active and is what gets reused");
    assert.equal(reuse.decision, result.replacement);

    // Correcting a criterion flags every annotation that cites it, including the fixture's P01 decision.
    const crit = runCli(["--json", "correct", "dec_crit0analyz1", "--reason", "we now count randomised"], { cwd: dir }).json as { needs_review: string[]; suspended: string[] };
    assert.ok(crit.needs_review.includes("dec_p01nanal0000"));
    assert.ok(crit.needs_review.includes(result.replacement!));
    assert.deepEqual(crit.suspended, []);
    // The ladder never offers a decision under review for reuse.
    const review = runCli(["--json", "resolve", "--unit", "P01", "--field", "n_analyzed_total"], { cwd: dir }).json as { mode: string; decision: string; advice: string };
    assert.equal(review.mode, "review");
    assert.equal(review.decision, "dec_p01nanal0000");
    assert.match(review.advice, /supersedes dec_p01nanal0000/);
    const k = runCli(["--json", "kpi"], { cwd: dir }).json as { procedures: { by_state: Record<string, number> }; decisions: { by_status: Record<string, number> }; transitions: { to: string }[] };
    assert.equal(k.procedures.by_state["suspended"], 1);
    assert.ok((k.decisions.by_status["needs_review"] ?? 0) >= 2);
    assert.ok(k.transitions.some((t) => t.to === "suspended"));
    const noEvidence = runCli(["--json", "procedure", "reinstate", "proc_tablecount01", "--reason", "fixed the parser"], { cwd: dir });
    assert.equal(noEvidence.status, 1, "reinstating needs evidence");
    const reinstated = runCli(["--json", "procedure", "reinstate", "proc_tablecount01", "--reason", "fixed the parser", "--evidence", "ev_p01execrand0"], { cwd: dir }).json as { state: string; counters: { shown_uses: number; corrections: number }; history: { to: string; caused_by: string }[] };
    assert.equal(reinstated.state, "provisional");
    assert.equal(reinstated.counters.shown_uses, 0);
    assert.equal(reinstated.counters.corrections, 0);
    assert.deepEqual(reinstated.history.map((h) => h.to), ["provisional", "trusted", "suspended", "provisional"]);
    // The reinstatement is a choice decision that names the procedure and cites the evidence; the history entry cites it.
    const choice = runCli(["--json", "get", reinstated.history[reinstated.history.length - 1]!.caused_by], { cwd: dir }).json as { kind: string; transition: { procedure: string; to: string }; depends_on: string[]; data: string[] };
    assert.equal(choice.kind, "choice");
    assert.deepEqual(choice.transition, { procedure: "proc_tablecount01", to: "provisional", reason: "fixed the parser" });
    assert.deepEqual(choice.depends_on, ["proc_tablecount01"]);
    assert.deepEqual(choice.data, ["ev_p01execrand0"]);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    const k2 = runCli(["--json", "kpi"], { cwd: dir }).json as { transitions: { from: string | null; to: string; session: string | null }[] };
    assert.ok(k2.transitions.some((t) => t.from === "suspended" && t.to === "provisional" && t.session === `ses_claude_${SESSION.replace(/-/g, "")}`), "the session of an explicit transition is found through its decision");
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
    const dec = runCli(["--json", "get", a.dec], { cwd: dir }).json as { shown_at: { turn: string; at: string }[] };
    assert.deepEqual(dec.shown_at.map((s) => s.turn), [TURN]);
    assert.match(dec.shown_at[0]!.at, /^\d{4}-\d{2}-\d{2}T/, "a shown event records its moment");
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
    const afterRetired = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number }; history: { to: string; caused_by: string }[] };
    assert.equal(afterRetired.state, "retired");
    assert.equal(afterRetired.counters.shown_uses, 4, "two from the fixture, two shown here, none after the retirement");
    const retireChoice = runCli(["--json", "get", afterRetired.history[afterRetired.history.length - 1]!.caused_by], { cwd: dir }).json as { kind: string; transition: { to: string } };
    assert.equal(retireChoice.kind, "choice");
    assert.equal(retireChoice.transition.to, "retired");
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
    assert.equal(afterSuspended.counters.shown_uses, 2, "the fixture's two; nothing shown after the suspension counts");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    retiredCase.cleanup();
    suspendedCase.cleanup();
  }
});

test("shown needs the turn it happened in, and repeating it changes nothing", () => {
  const { dir, cleanup } = tempToy();
  try {
    const noTurn = runCli(["--json", "shown", "dec_p01outcm0000"], { cwd: dir });
    assert.equal(noTurn.status, 1);
    assert.match(noTurn.stdout + noTurn.stderr, /current turn/);
    const withTurn = runCli(["--json", "shown", "dec_p01outcm0000", "--turn", "turn_claude_toyseed0001_0001"], { cwd: dir });
    assert.equal(withTurn.status, 0, withTurn.stdout);
    assert.deepEqual((withTurn.json as { shown: string[] }).shown, ["dec_p01outcm0000"]);
    const repeat = runCli(["--json", "shown", "dec_p01outcm0000", "--turn", "turn_claude_toyseed0001_0001"], { cwd: dir });
    assert.deepEqual((repeat.json as { already: string[] }).already, ["dec_p01outcm0000"]);
    const proc = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number } };
    assert.equal(proc.state, "provisional");
    assert.equal(proc.counters.shown_uses, 2, "the outcome decision used no procedure; the fixture's two uses stand");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("the cached state is a replay of the events: a stale cache is an error that recompute repairs", () => {
  const { dir, cleanup } = tempToy();
  try {
    const p = join(dir, "knowledge", "procedures", "proc_tablecount01.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("shown_uses: 2", "shown_uses: 0"));
    const broken = runCli(["--json", "validate"], { cwd: dir });
    assert.equal(broken.status, 2);
    assert.ok((broken.json as { issues: { code: string; message: string }[] }).issues.some((i) => i.code === "E_COUNTER_MISMATCH" && /procedure recompute/.test(i.message)));
    const fixed = runCli(["--json", "procedure", "recompute"], { cwd: dir });
    assert.equal(fixed.status, 0, fixed.stdout);
    assert.deepEqual((fixed.json as { id: string; changed: boolean; from: string; to: string }[]).map((x) => [x.id, x.changed, x.to]), [["proc_tablecount01", true, "provisional"]]);
    assert.equal((runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { counters: { shown_uses: number } }).counters.shown_uses, 2);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    const again = runCli(["--json", "procedure", "recompute", "proc_tablecount01"], { cwd: dir }).json as { changed: boolean }[];
    assert.equal(again[0]!.changed, false);
  } finally {
    cleanup();
  }
});

test("a correction is an identified event: applying it again changes nothing, and a superseded decision is not corrected twice", () => {
  const { dir, cleanup } = tempToy();
  try {
    startTurn(dir, "Annotate P02 and P03");
    const a = annotate(dir, "P02", "n_analyzed_total", 80, "dec_crit0analyz1");
    const b = annotate(dir, "P03", "n_analyzed_total", 150, "dec_crit0analyz1");
    const before = (runCli(["--json", "ls", "decision"], { cwd: dir }).json as unknown[]).length;
    const first = runCli(["--json", "correct", a.dec, "--reason", "per protocol here", "--value", "78"], { cwd: dir });
    assert.equal(first.status, 0, first.stdout);
    const r1 = first.json as { replacement: string; event: string; already: boolean };
    assert.equal(r1.already, false);
    const again = runCli(["--json", "correct", a.dec, "--reason", "per protocol here", "--value", "78"], { cwd: dir });
    assert.equal(again.status, 0, again.stdout);
    const r2 = again.json as { replacement: string; event: string; already: boolean; suspended: string[] };
    assert.equal(r2.already, true);
    assert.equal(r2.event, r1.event);
    assert.equal(r2.replacement, r1.replacement);
    assert.deepEqual(r2.suspended, []);
    assert.equal((runCli(["--json", "ls", "decision"], { cwd: dir }).json as unknown[]).length, before + 1, "one replacement, not two");
    assert.equal((runCli(["--json", "get", a.dec], { cwd: dir }).json as { corrections: unknown[] }).corrections.length, 1);
    // A decision that already left the cell is not the one to correct.
    const stale = runCli(["--json", "correct", a.dec, "--reason", "again", "--value", "79", "--event", "evt-other"], { cwd: dir });
    assert.equal(stale.status, 2);
    assert.match(stale.stdout, /superseded by/);
    // Without a value the decision stays, and a second event is a second entry.
    assert.equal(runCli(["correct", b.dec, "--reason", "check the arms"], { cwd: dir }).status, 0);
    assert.equal(runCli(["correct", b.dec, "--reason", "and the total", "--event", "evt-2"], { cwd: dir }).status, 0);
    const bDec = runCli(["--json", "get", b.dec], { cwd: dir }).json as { status: string; corrections: { event: string }[] };
    assert.equal(bDec.status, "needs_review");
    assert.equal(bDec.corrections.length, 2);
    assert.equal(bDec.corrections[1]!.event, "evt-2");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("without a current turn a correction needs an explicit event id", () => {
  const { dir, cleanup } = tempToy();
  try {
    const noTurn = runCli(["--json", "correct", "dec_p01nanal0000", "--reason", "x"], { cwd: dir });
    assert.equal(noTurn.status, 1);
    assert.match(noTurn.stdout + noTurn.stderr, /--event/);
    const withEvent = runCli(["--json", "correct", "dec_p01nanal0000", "--reason", "x", "--event", "evt-1"], { cwd: dir });
    assert.equal(withEvent.status, 0, withEvent.stdout);
    assert.equal((withEvent.json as { event: string }).event, "evt-1");
  } finally {
    cleanup();
  }
});

test("a cell holds one active annotation: a second one is refused until the first is superseded", () => {
  const { dir, cleanup } = tempToy();
  try {
    const dup = { title: "P01 n_analyzed_total again", kind: "annotation", status: "active", claim: "116", qualifier: { confidence: 0.9 }, fragility: "mechanical", target: { unit: "P01", field: "n_analyzed_total", value: 116 }, data: ["ev_p01table1000"], warrant: ["dec_crit0analyz1"] };
    const refused = runCli(["--json", "add", "decision", "--json-in", JSON.stringify(dup)], { cwd: dir });
    assert.equal(refused.status, 2);
    assert.match(refused.stdout, /E_DUPLICATE_ACTIVE/);
    assert.equal(runCli(["--json", "set", "dec_p01nanal0000", "--json-in", JSON.stringify({ status: "superseded" })], { cwd: dir }).status, 0);
    const accepted = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ ...dup, supersedes: ["dec_p01nanal0000"] })], { cwd: dir });
    assert.equal(accepted.status, 0, accepted.stdout);
    const res = runCli(["--json", "resolve", "--unit", "P01", "--field", "n_analyzed_total"], { cwd: dir }).json as { mode: string; decision: string };
    assert.equal(res.mode, "cached");
    assert.equal(res.decision, (accepted.json as { id: string }).id);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});
