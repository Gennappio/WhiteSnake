import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "fixture"]);
}

test("export of a plain store carries a manifest, passes check, and answers why identically", () => {
  const { dir, cleanup } = tempToy();
  const dest = join(mkdtempSync(join(tmpdir(), "whitesnake-export-")), "copy");
  try {
    const ex = runCli(["--json", "export", dest], { cwd: dir });
    assert.equal(ex.status, 0, ex.stdout);
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")) as { files: Record<string, string>; history_included: boolean; nodes: number };
    assert.equal(manifest.history_included, false);
    assert.equal(manifest.nodes, 23);
    assert.ok(Object.keys(manifest.files).some((f) => f.startsWith("knowledge/decisions/")));
    assert.ok(existsSync(join(dest, "review.html")));
    const check = runCli(["--json", "check"], { cwd: dest });
    assert.equal(check.status, 0, check.stdout);
    assert.equal((check.json as { ok: boolean }).ok, true);
    const whySrc = runCli(["--json", "why", "P01/n_analyzed_total"], { cwd: dir }).json;
    const whyDst = runCli(["--json", "why", "P01/n_analyzed_total"], { cwd: dest }).json;
    assert.deepEqual(whyDst, whySrc);
    // Tampering is detected.
    const p = join(dest, "knowledge", "decisions", "dec_p01nanal0000.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("value: 115", "value: 116"));
    const bad = runCli(["--json", "check"], { cwd: dest });
    assert.equal(bad.status, 2);
    assert.deepEqual((bad.json as { mismatched: string[] }).mismatched, ["knowledge/decisions/dec_p01nanal0000.md"]);
  } finally {
    cleanup();
    rmSync(join(dest, ".."), { recursive: true, force: true });
  }
});

test("export of a git store clones it; --no-history yields a single commit and says so", () => {
  const { dir, cleanup } = tempToy();
  const base = mkdtempSync(join(tmpdir(), "whitesnake-export-"));
  try {
    gitInit(dir);
    const full = runCli(["--json", "export", join(base, "full")], { cwd: dir });
    assert.equal(full.status, 0, full.stdout);
    assert.equal((full.json as { history_included: boolean }).history_included, true);
    const shallow = runCli(["--json", "export", join(base, "shallow"), "--no-history"], { cwd: dir });
    assert.equal(shallow.status, 0, shallow.stdout);
    assert.equal((shallow.json as { history_included: boolean }).history_included, false);
    assert.equal(execFileSync("git", ["-C", join(base, "shallow"), "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "1");
    assert.equal(runCli(["check"], { cwd: join(base, "shallow") }).status, 0);
    // Dirty stores are refused.
    writeFileSync(join(dir, "corpus", "extra.md"), "x");
    assert.notEqual(runCli(["export", join(base, "dirty")], { cwd: dir }).status, 0);
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});
