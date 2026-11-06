import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();

function gitInit(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
}

test("a parent branch gets its own worktree, is rebased on main when reopened, and merges additively", () => {
  const { dir, cleanup } = tempToy();
  try {
    gitInit(dir);
    const open = runCli(["--json", "branch", "open", "--parent", "alpha"], { cwd: dir });
    assert.equal(open.status, 0, open.stdout);
    const wt = (open.json as { worktree: string; created: boolean }).worktree;
    assert.ok(existsSync(join(wt, "whitesnake.yaml")));
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "parent/alpha");
    // Work on the branch: a new question, committed.
    const q = runCli(["--json", "add", "question", "--json-in", JSON.stringify({ title: "From alpha", why: "test" })], { cwd: wt });
    assert.equal(q.status, 0, q.stdout);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "alpha work");
    // Main moves on independently.
    const q2 = runCli(["--json", "add", "question", "--json-in", JSON.stringify({ title: "On main", why: "test" })], { cwd: dir });
    assert.equal(q2.status, 0, q2.stdout);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main work");
    const status = runCli(["--json", "branch", "status"], { cwd: dir }).json as { branch: string; ahead: number; behind: number }[];
    assert.deepEqual(status.map((s) => [s.branch, s.ahead, s.behind]), [["parent/alpha", 1, 1]]);
    const reopen = runCli(["--json", "branch", "open", "--parent", "alpha"], { cwd: dir }).json as { rebased: boolean; behind_before: number };
    assert.equal(reopen.rebased, true);
    assert.equal(reopen.behind_before, 1);
    assert.ok(existsSync(join(wt, "knowledge", "questions", `${(q2.json as { id: string }).id}.md`)), "main's commit is visible on the rebased branch");
    const merge = runCli(["--json", "branch", "merge", "alpha"], { cwd: dir });
    assert.equal(merge.status, 0, merge.stdout);
    assert.ok(existsSync(join(dir, "knowledge", "questions", `${(q.json as { id: string }).id}.md`)), "alpha's question reached main");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("a conflicting decision edit aborts the merge, lists the file as a decision conflict, and leaves main untouched", () => {
  const { dir, cleanup } = tempToy();
  try {
    gitInit(dir);
    const wt = (runCli(["--json", "branch", "open", "--parent", "beta"], { cwd: dir }).json as { worktree: string }).worktree;
    const file = "knowledge/decisions/dec_crit0random2.md";
    writeFileSync(join(wt, file), readFileSync(join(wt, file), "utf8").replace("confidence: 1", "confidence: 0.8"));
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "beta edit");
    writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8").replace("confidence: 1", "confidence: 0.6"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main edit");
    const head = git(dir, "rev-parse", "HEAD");
    const merge = runCli(["--json", "branch", "merge", "beta"], { cwd: dir });
    assert.equal(merge.status, 4);
    const details = (merge.json as { details: { file: string; kind: string }[] }).details;
    assert.deepEqual(details, [{ file, kind: "decision" }]);
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "main did not move");
    assert.equal(git(dir, "status", "--porcelain"), "", "no partial merge state");
    // Reopening the branch now conflicts on rebase and is refused cleanly.
    const reopen = runCli(["--json", "branch", "open", "--parent", "beta"], { cwd: dir });
    assert.equal(reopen.status, 3);
    assert.equal(git(wt, "status", "--porcelain"), "", "worktree left clean after the aborted rebase");
  } finally {
    cleanup();
  }
});

const SESSION_BRANCH = "33333333-4444-5555-6666-777777777777";
const SESSION_MAIN = "44444444-5555-6666-7777-888888888888";

function startTurn(dir: string, session: string, prompt: string): void {
  const r = runCli(["hooks", "run", "UserPromptSubmit"], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: session, hook_event_name: "UserPromptSubmit", prompt }) });
  assert.equal(r.status, 0, r.stderr);
}

/** One leaf episode that uses the fixture procedure, produces an annotation and shows it to the researcher. */
function annotateAndShow(dir: string, unit: string): string {
  const ep = runCli(["--json", "episode", "open", `${unit} n_randomized_total`, "--resolution", "code", "--uses", "proc_tablecount01", "dec_crit0random2"], { cwd: dir });
  assert.equal(ep.status, 0, ep.stdout);
  const epId = (ep.json as { id: string }).id;
  const ev = runCli(["--json", "add", "evidence", "--json-in", JSON.stringify({ title: `${unit} table`, kind: "excerpt", locator: { artifact: "art_p02b8n4p0r5y" }, produced_by: epId }), "--body", `| ${unit} | 84 |`], { cwd: dir });
  const evId = (ev.json as { id: string }).id;
  const dec = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: `${unit} n_randomized_total`, kind: "annotation", status: "active", claim: "84", qualifier: { confidence: 0.9 }, fragility: "mechanical", target: { unit, field: "n_randomized_total", value: 84 }, data: [evId], warrant: ["dec_crit0random2"], depends_on: ["proc_tablecount01"], produced_by: epId })], { cwd: dir });
  assert.equal(dec.status, 0, dec.stdout);
  const decId = (dec.json as { id: string }).id;
  assert.equal(runCli(["episode", "close", epId, "--produces", evId, decId], { cwd: dir }).status, 0);
  assert.equal(runCli(["shown", decId], { cwd: dir }).status, 0);
  return decId;
}

const procState = (dir: string) => runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; counters: { shown_uses: number; corrections: number }; history: { to: string }[] };

test("a procedure used on both sides merges: the cache-only conflict is resolved and the counters add up", () => {
  const { dir, cleanup } = tempToy();
  try {
    gitInit(dir);
    const wt = (runCli(["--json", "branch", "open", "--parent", "gamma"], { cwd: dir }).json as { worktree: string }).worktree;
    startTurn(wt, SESSION_BRANCH, "Annotate P02 on the branch");
    annotateAndShow(wt, "P02");
    assert.equal(procState(wt).counters.shown_uses, 3);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "gamma work");
    startTurn(dir, SESSION_MAIN, "Annotate P03 on main");
    annotateAndShow(dir, "P03");
    assert.equal(procState(dir).counters.shown_uses, 3);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main work");
    const merge = runCli(["--json", "branch", "merge", "gamma"], { cwd: dir });
    assert.equal(merge.status, 0, merge.stdout);
    const r = merge.json as { merged: boolean; cache_conflicts_resolved: string[]; recomputed: string[] };
    assert.equal(r.merged, true);
    assert.deepEqual(r.cache_conflicts_resolved, ["knowledge/procedures/proc_tablecount01.md"]);
    assert.deepEqual(r.recomputed, ["proc_tablecount01"]);
    const after = procState(dir);
    assert.equal(after.counters.shown_uses, 4, "two from the fixture, one from each side");
    assert.equal(after.state, "trusted");
    assert.deepEqual(after.history.map((h) => h.to), ["provisional", "trusted"]);
    assert.equal(git(dir, "status", "--porcelain"), "", "the merge commit holds the derived cache");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("reopening a branch after main used the same procedure rebases through the cache conflict and derives again", () => {
  const { dir, cleanup } = tempToy();
  try {
    gitInit(dir);
    const wt = (runCli(["--json", "branch", "open", "--parent", "delta"], { cwd: dir }).json as { worktree: string }).worktree;
    startTurn(wt, SESSION_BRANCH, "Annotate P02 on the branch");
    annotateAndShow(wt, "P02");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "delta work");
    startTurn(dir, SESSION_MAIN, "Annotate P03 on main");
    annotateAndShow(dir, "P03");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "main work");
    const reopen = runCli(["--json", "branch", "open", "--parent", "delta"], { cwd: dir });
    assert.equal(reopen.status, 0, reopen.stdout);
    const r = reopen.json as { rebased: boolean; recomputed: string[] };
    assert.equal(r.rebased, true);
    assert.deepEqual(r.recomputed, ["proc_tablecount01"]);
    const after = procState(wt);
    assert.equal(after.counters.shown_uses, 4);
    assert.equal(after.state, "trusted");
    assert.match(git(wt, "log", "-1", "--format=%s"), /recompute derived state after rebase/);
    assert.equal(git(wt, "status", "--porcelain"), "");
    assert.equal(runCli(["validate"], { cwd: wt }).status, 0);
  } finally {
    cleanup();
  }
});
