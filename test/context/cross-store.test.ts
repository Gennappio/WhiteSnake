import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const SESSION = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const TURN = "turn_claude_777777778888999aaaabbbbbbbbbbbb_0001";

test("from inside a store, a write to another store lands on the caller's branch of that store with the caller's turn mirrored", () => {
  const parent = tempToy();
  const child = tempToy();
  try {
    const cfg = join(parent.dir, "whitesnake.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^id: toy$/m, "id: parent-lab"));
    git(child.dir, "init", "-q", "-b", "main");
    git(child.dir, "add", "-A");
    git(child.dir, "commit", "-q", "-m", "fixture");
    // The parent has a live turn.
    const hook = runCli(["hooks", "run", "UserPromptSubmit"], { cwd: parent.dir, input: JSON.stringify({ cwd: parent.dir, session_id: SESSION, hook_event_name: "UserPromptSubmit", prompt: "Fill the child's gap" }) });
    assert.equal(hook.status, 0, hook.stderr);
    const r = runCli(["--json", "--store", child.dir, "add", "question", "--json-in", JSON.stringify({ title: "Which population is analysed in P05?", why: "needed by the parent" })], { cwd: parent.dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /cross-store call/);
    const q = r.json as { id: string; caused_by: string; created_by: string };
    assert.equal(q.caused_by, TURN, "the parent's turn was mirrored and used as caused_by");
    assert.equal(q.created_by, "agent:parent-lab");
    const wt = join(child.dir, ".whitesnake", "worktrees", "parent-lab");
    assert.ok(existsSync(join(wt, "knowledge", "questions", `${q.id}.md`)), "written on the parent's branch of the child");
    assert.ok(!existsSync(join(child.dir, "knowledge", "questions", `${q.id}.md`)), "the child's main is untouched");
    assert.ok(!existsSync(join(parent.dir, "knowledge", "questions", `${q.id}.md`)), "nothing was imprinted in the parent");
    assert.ok(existsSync(join(wt, "knowledge", "turns", `${TURN}.md`)), "the turn exists in the child");
    assert.equal(runCli(["validate"], { cwd: wt }).status, 0, "the child's branch validates with the mirrored provenance");
    const why = runCli(["--json", "why", q.id], { cwd: wt }).json as { children: { rel: string; node: { id: string } }[] };
    assert.ok(why.children.some((c) => c.rel === "caused_by" && c.node.id === TURN));
    // --on-main bypasses the branch for reconciliation and tooling.
    const direct = runCli(["--json", "--store", child.dir, "--on-main", "add", "question", "--json-in", JSON.stringify({ title: "Admin note", why: "tooling" })], { cwd: parent.dir });
    assert.equal(direct.status, 0, direct.stdout);
    assert.ok(existsSync(join(child.dir, "knowledge", "questions", `${(direct.json as { id: string }).id}.md`)));
    // From outside any store, --store is used as is.
    const outside = runCli(["--json", "--store", child.dir, "ls", "question"], { cwd: "/" });
    assert.equal(outside.status, 0);
  } finally {
    parent.cleanup();
    child.cleanup();
  }
});
