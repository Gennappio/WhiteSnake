import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

test("validate and check compare every artifact with its registered sha256", () => {
  const { dir, cleanup } = tempToy();
  try {
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    assert.ok(existsSync(join(dir, ".whitesnake", "artifact-hashes.json")), "the first validate fills the size/mtime cache");
    const p = join(dir, "corpus", "P01.md");
    const original = readFileSync(p, "utf8");
    writeFileSync(p, `${original}\nAdded after registration.\n`);
    const bad = runCli(["--json", "validate"], { cwd: dir });
    assert.equal(bad.status, 2);
    const issues = (bad.json as { issues: { code: string; id: string }[] }).issues;
    assert.ok(issues.some((i) => i.code === "E_ARTIFACT_HASH" && i.id === "art_p01a7k3m9q2x"), JSON.stringify(issues));
    const check = runCli(["--json", "check", "--no-run"], { cwd: dir });
    assert.equal(check.status, 2);
    assert.deepEqual((check.json as { artifacts_changed: string[] }).artifacts_changed, ["corpus/P01.md"]);
    writeFileSync(p, original);
    assert.equal(runCli(["validate", "--full"], { cwd: dir }).status, 0);
    assert.equal(runCli(["--json", "check", "--no-run"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});
