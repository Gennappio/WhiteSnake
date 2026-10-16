import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ingestParsed, parseClaudeLog, promptTextOf } from "../../src/ingest/claude.js";
import { FIXTURES, tempToy } from "../helpers.js";

const fixture = join(FIXTURES, "claude-session.jsonl");

test("prompt text excludes tool results and tag-wrapped context blocks", () => {
  assert.equal(promptTextOf([{ type: "tool_result", content: "x" }]), null);
  assert.equal(promptTextOf([{ type: "text", text: "<ide_opened_file>a</ide_opened_file>" }, { type: "text", text: "real" }]), "real");
  assert.equal(promptTextOf("plain"), "plain");
  assert.equal(promptTextOf([{ type: "text", text: "<only_tag>a</only_tag>" }]), "<only_tag>a</only_tag>");
});

test("a Claude Code log yields one session and one turn per real prompt with deterministic ids", () => {
  const parsed = parseClaudeLog(readFileSync(fixture, "utf8"), fixture);
  assert.ok(parsed);
  assert.equal(parsed.session.id, "ses_claude_0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  assert.equal(parsed.session.model, "claude-test");
  assert.equal(parsed.session.git_branch, "main");
  assert.deepEqual(
    parsed.turns.map((t) => [t.id, t.index, t.prompt_excerpt]),
    [
      ["turn_claude_0f1e2d3c4b5a69788796a5b4c3d2e1f0_0001", 1, "Annotate P02 following the output schema."],
      ["turn_claude_0f1e2d3c4b5a69788796a5b4c3d2e1f0_0002", 2, "When both ITT and per-protocol are reported, count ITT."],
      ["turn_claude_0f1e2d3c4b5a69788796a5b4c3d2e1f0_0003", 3, "Thanks, now explain P02/n_analyzed_total."],
    ],
  );
});

test("ingesting twice writes nothing new", () => {
  const { dir, cleanup } = tempToy();
  try {
    const parsed = parseClaudeLog(readFileSync(fixture, "utf8"), fixture)!;
    const first = ingestParsed(dir, parsed);
    assert.equal(first.written, 4);
    const count = () => readdirSync(join(dir, "knowledge", "turns")).filter((f) => f.endsWith(".md")).length + readdirSync(join(dir, "knowledge", "sessions")).filter((f) => f.endsWith(".md")).length;
    const after = count();
    const second = ingestParsed(dir, parsed);
    assert.equal(second.written, 0);
    assert.equal(count(), after);
  } finally {
    cleanup();
  }
});
