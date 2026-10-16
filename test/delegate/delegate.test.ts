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

test("ask with the stub harness returns a cited answer", () => {
  const { dir, cleanup } = tempToy();
  try {
    const r = runCli(["--json", "ask", "--harness", "stub", "why does P01 count 115 analysed participants?"], { cwd: dir, env });
    assert.equal(r.status, 0, r.stdout);
    const a = r.json as { answer: string; records: string[]; confidence: number };
    assert.match(a.answer, /115/);
    assert.ok(a.records.includes("dec_p01nanal0000"));
    assert.equal(a.confidence, 0.9);
  } finally {
    cleanup();
  }
});

test("delegation runs the child on the parent's branch and records the answer as evidence with a remote child episode", () => {
  const parent = tempToy();
  const child = tempToy();
  try {
    // Distinct store ids: the branch in the child is named after the parent.
    const cfg = join(parent.dir, "whitesnake.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^id: toy$/m, "id: parent-lab"));
    gitInit(parent.dir);
    gitInit(child.dir);
    const r = runCli(["--json", "delegate", "--child", child.dir, "--question", "How many participants were randomised in P02?", "--why", "needed for the pooled total", "--harness", "stub"], { cwd: parent.dir, env });
    assert.equal(r.status, 0, r.stdout);
    const d = r.json as { task: { id: string }; branch: string; worktree: string; child_commit: string | null; output: { status: string; episode_id: string; decision_ids: string[] }; parent_episode: string; parent_evidence: string; parent_artifact: string };
    assert.equal(d.branch, "parent/parent-lab");
    assert.equal(d.output.status, "completed");
    assert.ok(d.child_commit, "the child's work was committed on its branch");
    // Child side: the work exists on the branch, not on main.
    assert.ok(existsSync(join(d.worktree, "knowledge", "decisions", `${d.output.decision_ids[0]}.md`)));
    assert.ok(!existsSync(join(child.dir, "knowledge", "decisions", `${d.output.decision_ids[0]}.md`)), "main of the child is untouched until reconciliation");
    assert.equal(runCli(["validate"], { cwd: d.worktree }).status, 0);
    // Parent side: episode with a remote child, execution evidence pointing at the saved answer.
    const ep = runCli(["--json", "get", d.parent_episode], { cwd: parent.dir }).json as { children: { store: string; id: string }[]; outcome: string; produces: string[] };
    assert.deepEqual(ep.children, [{ store: "toy", id: d.output.episode_id }]);
    assert.equal(ep.outcome, "success");
    assert.ok(ep.produces.includes(d.parent_evidence));
    const ev = runCli(["--json", "get", d.parent_evidence], { cwd: parent.dir }).json as { kind: string; locator: { artifact: string }; body: string };
    assert.equal(ev.kind, "execution");
    assert.equal(ev.locator.artifact, d.parent_artifact);
    assert.match(ev.body, new RegExp(d.output.decision_ids[0]!));
    assert.ok(existsSync(join(parent.dir, "artifacts", "delegations", `${d.task.id}.json`)));
    assert.equal(runCli(["validate"], { cwd: parent.dir }).status, 0);
    const why = runCli(["--json", "why", d.parent_evidence], { cwd: parent.dir }).json as { children: { rel: string; node: { type: string } }[] };
    assert.ok(why.children.some((c) => c.rel === "locator" && c.node.type === "artifact"));
    // And the answer is explainable in the child store itself.
    const childWhy = runCli(["--json", "why", "P02/n_randomized_total"], { cwd: d.worktree }).json as { id: string };
    assert.equal(childWhy.id, d.output.decision_ids[0]);
    assert.equal(git(parent.dir, "status", "--porcelain"), "", "parent changes were committed");
  } finally {
    parent.cleanup();
    child.cleanup();
  }
});
