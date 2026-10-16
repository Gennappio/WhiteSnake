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
    assert.ok(existsSync(join(wt, "autosoft.yaml")));
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
