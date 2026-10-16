import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const hook = (dir: string, event: string, payload: Record<string, unknown>) =>
  runCli(["hooks", "run", event], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: "11111111-2222-3333-4444-555555555555", hook_event_name: event, ...payload }) });

test("UserPromptSubmit creates the turn node and the current-turn file; add picks it up as caused_by", () => {
  const { dir, cleanup } = tempToy();
  try {
    const r = hook(dir, "UserPromptSubmit", { prompt: "Annotate P02" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /turn_claude_11111111222233334444555555555555_0001/);
    assert.equal(readFileSync(join(dir, ".whitesnake", "current-turn"), "utf8").trim(), "turn_claude_11111111222233334444555555555555_0001");
    assert.ok(existsSync(join(dir, "knowledge", "sessions", "ses_claude_11111111222233334444555555555555.md")));
    const add = runCli(["--json", "add", "question", "--json-in", JSON.stringify({ title: "Q?", why: "because" })], { cwd: dir });
    assert.equal(add.status, 0, add.stderr);
    assert.equal((add.json as { caused_by: string }).caused_by, "turn_claude_11111111222233334444555555555555_0001");
    const second = hook(dir, "UserPromptSubmit", { prompt: "Next" });
    assert.match(second.stdout, /_0002/);
  } finally {
    cleanup();
  }
});

test("PreToolUse denies direct writes under knowledge/ and nudges on direct reads", () => {
  const { dir, cleanup } = tempToy();
  try {
    const deny = hook(dir, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(dir, "knowledge", "decisions", "x.md") } });
    assert.equal(deny.status, 0);
    assert.equal((JSON.parse(deny.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
    const nudge = hook(dir, "PreToolUse", { tool_name: "Read", tool_input: { file_path: join(dir, "knowledge", "decisions", "x.md") } });
    const out = JSON.parse(nudge.stdout) as { hookSpecificOutput: { permissionDecision: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
    assert.match(out.hookSpecificOutput.additionalContext, /precedent/);
    const elsewhere = hook(dir, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(dir, "corpus", "P02.md") } });
    assert.equal(elsewhere.stdout.trim(), "");
    const log = readFileSync(join(dir, ".whitesnake", "hooks.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 3);
  } finally {
    cleanup();
  }
});

test("SessionStart prints the mandate and the frontier; outside a store hooks are silent", () => {
  const { dir, cleanup } = tempToy();
  try {
    const r = hook(dir, "SessionStart", { source: "startup" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Toy trial annotation store/);
    assert.match(r.stdout, /Open questions \(1\)/);
    const outside = runCli(["hooks", "run", "SessionStart"], { cwd: "/", input: JSON.stringify({ cwd: "/" }) });
    assert.equal(outside.status, 0);
    assert.equal(outside.stdout.trim(), "");
  } finally {
    cleanup();
  }
});

test("PreToolUse denies shell commands that write under knowledge/ but allows the CLI and plain reads", () => {
  const { dir, cleanup } = tempToy();
  try {
    const decision = (cmd: string) => {
      const r = hook(dir, "PreToolUse", { tool_name: "Bash", tool_input: { command: cmd } });
      if (!r.stdout.trim()) return "silent";
      return (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
    };
    assert.equal(decision("echo x > knowledge/decisions/dec_aaaaaaaaaaaa.md"), "deny");
    assert.equal(decision("cat body.md | tee knowledge/evidence/ev_aaaaaaaaaaaa.md"), "deny");
    assert.equal(decision("sed -i '' 's/a/b/' knowledge/decisions/dec_p01nanal0000.md"), "deny");
    assert.equal(decision("rm -rf knowledge/episodes"), "deny");
    assert.equal(decision("whitesnake add decision --json-in '{\"title\":\"x\"}' --body 'see knowledge/'"), "silent");
    assert.equal(decision("cat knowledge/decisions/dec_p01nanal0000.md"), "allow");
    assert.equal(decision("ls -R corpus knowledge | head"), "allow");
    assert.equal(decision("python3 procedures/table_counts/run.py corpus/P02.md Randomised"), "silent");
    const patch = hook(dir, "PreToolUse", { tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Add File: knowledge/decisions/dec_bbbbbbbbbbbb.md\n+---\n*** End Patch" } });
    assert.equal((JSON.parse(patch.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    cleanup();
  }
});
