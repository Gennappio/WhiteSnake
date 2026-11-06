import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, REPO_ROOT, runCli, tempToy } from "../helpers.js";

const STUB = join(FIXTURES, "stub-agent.sh");
const env = { WHITESNAKE_STUB_SCRIPT: STUB, PATH: `${join(REPO_ROOT, "bin")}:${process.env["PATH"] ?? ""}` };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const gitInit = (dir: string) => {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
};
const SESSION = "99999999-aaaa-bbbb-cccc-dddddddddddd";
const T1 = "turn_claude_99999999aaaabbbbccccdddddddddddd_0001";
const T2 = "turn_claude_99999999aaaabbbbccccdddddddddddd_0002";

function startTurn(dir: string, prompt: string): void {
  const r = runCli(["hooks", "run", "UserPromptSubmit"], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: SESSION, hook_event_name: "UserPromptSubmit", prompt }) });
  assert.equal(r.status, 0, r.stderr);
}

interface Setup {
  parent: { dir: string; cleanup: () => void };
  child: { dir: string; cleanup: () => void };
  /** The child's decision behind the delegated answer, and the parent's decision that rests on it. */
  D: string;
  L: string;
  worktree: string;
  parentEvidence: string;
}

type Proc = { state: string; counters: { shown_uses: number; corrections: number }; history: { to: string }[] };
const proc = (dir: string): Proc => runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as Proc;
type Dec = { status: string; shown_at: { turn: string; at: string }[]; corrections: { turn: string | null; event: string; actor: string }[]; supersedes: string[]; target: { value: unknown }; created_by: string };
const dec = (dir: string, id: string): Dec => runCli(["--json", "get", id], { cwd: dir }).json as Dec;

/** A parent that delegated P02 to the toy child and recorded its own decision on the child's answer. */
function setup(): Setup {
  const parent = tempToy();
  const child = tempToy();
  const cfg = join(parent.dir, "whitesnake.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^id: toy$/m, "id: parent-lab").replace("stores: {}", `stores:\n  toy: ${child.dir}`));
  gitInit(parent.dir);
  gitInit(child.dir);
  startTurn(parent.dir, "Delegate P02 to the toy child");
  const r = runCli(["--json", "delegate", "--child", "toy", "--question", "How many participants were randomised in P02?", "--harness", "stub"], { cwd: parent.dir, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const d = r.json as { worktree: string; output: { decision_ids: string[] }; parent_evidence: string };
  const D = d.output.decision_ids[0]!;
  const head = git(d.worktree, "rev-parse", "HEAD");
  const add = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: "P02 n_randomized_total (from toy)", kind: "annotation", status: "active", claim: "84 randomised, as the toy store found", qualifier: { confidence: 0.9, scope: "P02" }, fragility: "mechanical", target: { unit: "P02", field: "n_randomized_total", value: 84 }, data: [d.parent_evidence], warrant: ["dec_crit0random2"], depends_on: [{ store: "toy", id: D, commit: head }] })], { cwd: parent.dir });
  assert.equal(add.status, 0, add.stdout);
  return { parent, child, D, L: (add.json as { id: string }).id, worktree: d.worktree, parentEvidence: d.parent_evidence };
}

test("shown and corrected in the parent reach the child's branch, count there under the branch owner, leave main alone and raise a question on the shared procedure; a retry delivers nothing twice", () => {
  const s = setup();
  try {
    // Shown: the parent's decision rests on the child's; the event is queued and delivered on the parent's branch of the child.
    const shown = runCli(["--json", "shown", s.L], { cwd: s.parent.dir });
    assert.equal(shown.status, 0, shown.stdout);
    const remote = (shown.json as { remote: { event: string; target: { store: string; id: string } }[] }).remote;
    assert.equal(remote.length, 1, "one event for the one child decision, cited twice (depends_on and the evidence's cites)");
    assert.deepEqual(remote[0]!.target, { store: "toy", id: s.D, commit: git(s.worktree, "rev-parse", "HEAD") });
    const sync1 = runCli(["--json", "sync"], { cwd: s.parent.dir });
    assert.equal(sync1.status, 0, sync1.stdout + sync1.stderr);
    const r1 = sync1.json as { delivered: { kind: string; branch: string; commit: string | null; question: string | null }[]; pending: unknown[] };
    assert.deepEqual(r1.pending, []);
    assert.equal(r1.delivered.length, 1);
    assert.equal(r1.delivered[0]!.kind, "shown");
    assert.equal(r1.delivered[0]!.branch, "parent/parent-lab");
    assert.ok(r1.delivered[0]!.commit);
    const shownD = dec(s.worktree, s.D);
    assert.deepEqual(shownD.shown_at.map((x) => x.turn), [T1]);
    assert.match(shownD.shown_at[0]!.at, /^\d{4}-/);
    assert.equal(proc(s.worktree).counters.shown_uses, 3, "the fixture's two plus the parent's acceptance");
    assert.equal(proc(s.worktree).state, "trusted");
    assert.equal(proc(s.child.dir).counters.shown_uses, 2, "main of the child is untouched");
    assert.equal(proc(s.child.dir).state, "provisional");
    const turn = runCli(["--json", "get", T1], { cwd: s.worktree }).json as { prompt_excerpt: string; created_by: string; prompt_hash: string };
    assert.equal(turn.prompt_excerpt, "", "the mirrored turn carries no prompt text");
    assert.equal(turn.created_by, "sync:parent-lab");
    assert.match(turn.prompt_hash, /^[0-9a-f]{64}$/);
    assert.equal(runCli(["validate"], { cwd: s.worktree }).status, 0);
    assert.equal(git(s.worktree, "status", "--porcelain"), "", "the delivery is committed on the branch");

    // Corrected: the parent's researcher changes the value in a later turn.
    startTurn(s.parent.dir, "Correct P02");
    const corr = runCli(["--json", "correct", s.L, "--reason", "both arms are 43", "--value", "86"], { cwd: s.parent.dir });
    assert.equal(corr.status, 0, corr.stdout);
    assert.equal((corr.json as { remote: unknown[] }).remote.length, 1);
    const sync2 = runCli(["--json", "sync"], { cwd: s.parent.dir });
    assert.equal(sync2.status, 0, sync2.stdout + sync2.stderr);
    const r2 = sync2.json as { delivered: { event: string; kind: string; question: string | null }[]; pending: unknown[] };
    assert.equal(r2.delivered.length, 1);
    assert.equal(r2.delivered[0]!.kind, "corrected");
    assert.ok(r2.delivered[0]!.question, "a correction that touches a procedure main also serves raises a question");
    const correctedD = dec(s.worktree, s.D);
    assert.equal(correctedD.status, "superseded");
    assert.equal(correctedD.corrections.length, 1);
    assert.equal(correctedD.corrections[0]!.event, r2.delivered[0]!.event);
    assert.equal(correctedD.corrections[0]!.turn, T2);
    assert.equal(correctedD.corrections[0]!.actor, "human:researcher@parent-lab", "the branch owner corrected it");
    const replacement = (runCli(["--json", "ls", "decision", "--status", "active"], { cwd: s.worktree }).json as { id: string }[]).map((row) => dec(s.worktree, row.id)).find((x) => x.supersedes.includes(s.D));
    assert.ok(replacement, "the value was forwarded because the cells match");
    assert.equal(replacement!.target.value, 86);
    assert.equal(replacement!.created_by, "human:researcher@parent-lab");
    const branchProc = proc(s.worktree);
    assert.equal(branchProc.state, "suspended");
    assert.deepEqual(branchProc.counters, { shown_uses: 3, corrections: 1 });
    assert.deepEqual(branchProc.history.map((h) => h.to), ["provisional", "trusted", "suspended"]);
    const q = runCli(["--json", "get", r2.delivered[0]!.question!], { cwd: s.worktree }).json as { status: string; title: string; caused_by: string; created_by: string };
    assert.equal(q.status, "open");
    assert.match(q.title, /touches shared procedure proc_tablecount01/);
    assert.equal(q.caused_by, T2);
    assert.equal(q.created_by, "sync:parent-lab");
    const status = runCli(["--json", "branch", "status"], { cwd: s.child.dir }).json as { branch: string; questions: string[] }[];
    assert.deepEqual(status.map((b) => [b.branch, b.questions]), [["parent/parent-lab", [r2.delivered[0]!.question]]]);
    assert.equal(proc(s.child.dir).state, "provisional", "nothing on main moved");
    assert.deepEqual(proc(s.child.dir).counters, { shown_uses: 2, corrections: 0 });
    assert.ok(!existsSync(join(s.child.dir, "knowledge", "questions", `${r2.delivered[0]!.question}.md`)));
    assert.equal(runCli(["validate"], { cwd: s.worktree }).status, 0);
    assert.equal(git(s.worktree, "status", "--porcelain"), "");

    // Retry: nothing is delivered twice, nothing is duplicated.
    const sync3 = runCli(["--json", "sync"], { cwd: s.parent.dir }).json as { delivered: unknown[]; pending: unknown[] };
    assert.deepEqual(sync3, { delivered: [], pending: [] });
    assert.equal(dec(s.worktree, s.D).corrections.length, 1);
    assert.equal((runCli(["--json", "ls", "question", "--status", "open"], { cwd: s.worktree }).json as unknown[]).length, 2, "the fixture's open question and the one raised here");
  } finally {
    s.parent.cleanup();
    s.child.cleanup();
  }
});

test("the order of delivery does not change what the child derives", () => {
  const s = setup();
  try {
    assert.equal(runCli(["shown", s.L], { cwd: s.parent.dir }).status, 0);
    startTurn(s.parent.dir, "Correct P02");
    assert.equal(runCli(["correct", s.L, "--reason", "both arms are 43", "--value", "86"], { cwd: s.parent.dir }).status, 0);
    const outbox = join(s.parent.dir, ".whitesnake", "outbox.jsonl");
    const lines = readFileSync(outbox, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    writeFileSync(outbox, `${lines.reverse().join("\n")}\n`);
    const sync = runCli(["--json", "sync"], { cwd: s.parent.dir }).json as { delivered: { kind: string }[]; pending: unknown[] };
    assert.deepEqual(sync.delivered.map((d) => d.kind), ["corrected", "shown"]);
    assert.deepEqual(sync.pending, []);
    const p = proc(s.worktree);
    assert.equal(p.state, "suspended");
    assert.deepEqual(p.counters, { shown_uses: 3, corrections: 1 });
    assert.deepEqual(p.history.map((h) => h.to), ["provisional", "trusted", "suspended"], "the acceptance happened before the correction, whichever arrived first");
    const d = dec(s.worktree, s.D);
    assert.deepEqual(d.shown_at.map((x) => x.turn), [T1]);
    assert.equal(d.corrections.length, 1);
    assert.equal(runCli(["validate"], { cwd: s.worktree }).status, 0);
  } finally {
    s.parent.cleanup();
    s.child.cleanup();
  }
});

test("the Stop hook delivers what it can and never fails the session; an id unknown here but cited remotely is forwarded", () => {
  const s = setup();
  try {
    assert.equal(runCli(["correct", s.L, "--reason", "both arms are 43", "--value", "86"], { cwd: s.parent.dir }).status, 0);
    const stop = runCli(["hooks", "run", "Stop"], { cwd: s.parent.dir, input: JSON.stringify({ cwd: s.parent.dir, session_id: SESSION, hook_event_name: "Stop" }) });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(dec(s.worktree, s.D).status, "superseded", "the hook delivered the correction");
    assert.match(readFileSync(join(s.parent.dir, ".whitesnake", "hooks.log"), "utf8"), /"sync"/);
    // The child is no longer reachable: the next event waits, the hook still exits 0.
    const cfg = join(s.parent.dir, "whitesnake.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/stores:\n  toy: .*\n/, "stores: {}\n"));
    startTurn(s.parent.dir, "Show again");
    assert.equal(runCli(["shown", s.L], { cwd: s.parent.dir }).status, 0);
    const stop2 = runCli(["hooks", "run", "Stop"], { cwd: s.parent.dir, input: JSON.stringify({ cwd: s.parent.dir, session_id: SESSION, hook_event_name: "Stop" }) });
    assert.equal(stop2.status, 0, stop2.stderr);
    const pending = (runCli(["--json", "sync"], { cwd: s.parent.dir }).json as { pending: { reason: string }[] }).pending;
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.reason, /not registered/);
    // An id the parent does not hold, but cites through its delegation evidence, is forwarded too (in a new turn: the
    // acceptance of the same record in the same turn was queued above, and the outbox holds one event per record and turn).
    startTurn(s.parent.dir, "Show the child's own decision");
    const unknown = runCli(["--json", "shown", s.D], { cwd: s.parent.dir }).json as { unknown: string[]; remote: { target: { store: string; id: string } }[] };
    assert.deepEqual(unknown.unknown, [s.D]);
    assert.deepEqual(unknown.remote.map((r) => r.target.id), [s.D]);
  } finally {
    s.parent.cleanup();
    s.child.cleanup();
  }
});
