import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ingestParsed } from "../../src/ingest/claude.js";
import { parseCodexLog } from "../../src/ingest/codex.js";
import { detectLogFormat, ingestLogFile } from "../../src/ingest/index.js";
import { FIXTURES, tempToy } from "../helpers.js";

const fixture = join(FIXTURES, "codex-session.jsonl");
const claudeFixture = join(FIXTURES, "claude-session.jsonl");

test("log format detection distinguishes Codex rollouts from Claude Code transcripts", () => {
  assert.equal(detectLogFormat(readFileSync(fixture, "utf8")), "codex");
  assert.equal(detectLogFormat(readFileSync(claudeFixture, "utf8")), "claude");
  assert.equal(detectLogFormat("not json\n"), "unknown");
});

test("a Codex rollout yields one session and one turn per user prompt, ignoring environment context and echoed events", () => {
  const parsed = parseCodexLog(readFileSync(fixture, "utf8"), fixture);
  assert.ok(parsed);
  assert.equal(parsed.session.id, "ses_codex_01a13f275b9a7f2288dcaaaaaaaaaaaa");
  assert.equal(parsed.session.harness, "codex");
  assert.equal(parsed.session.model, "gpt-test");
  assert.equal(parsed.session.cwd, "/x/store");
  assert.deepEqual(
    parsed.turns.map((t) => [t.id, t.native_id, t.prompt_excerpt]),
    [
      ["turn_codex_01a13f275b9a7f2288dcaaaaaaaaaaaa_0001", "turn-aaa-1", "Annotate P02 following the output schema."],
      ["turn_codex_01a13f275b9a7f2288dcaaaaaaaaaaaa_0002", "turn-aaa-2", "When both ITT and per-protocol are reported, count ITT."],
    ],
  );
});

test("ingesting a Codex rollout through the dispatcher is idempotent", () => {
  const { dir, cleanup } = tempToy();
  try {
    const first = ingestLogFile(dir, fixture);
    assert.ok(first);
    assert.equal(first.format, "codex");
    assert.equal(first.written, 3);
    const count = () => readdirSync(join(dir, "knowledge", "turns")).filter((f) => f.endsWith(".md")).length;
    const n = count();
    const second = ingestParsed(dir, parseCodexLog(readFileSync(fixture, "utf8"), fixture)!);
    assert.equal(second.written, 0);
    assert.equal(count(), n);
  } finally {
    cleanup();
  }
});
