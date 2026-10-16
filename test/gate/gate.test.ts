import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT, runCli, tempToy } from "../helpers.js";

test("the committed contract snapshot matches the CLI, and removals or renames are reported as breaking", () => {
  const { dir, cleanup } = tempToy();
  const tmp = mkdtempSync(join(tmpdir(), "autosoft-gate-"));
  try {
    const committed = join(REPO_ROOT, "contract.json");
    const ok = runCli(["--json", "gate", "--against", committed], { cwd: dir });
    assert.equal(ok.status, 0, ok.stdout);
    assert.equal((ok.json as { breaking: string[] }).breaking.length, 0);
    // A snapshot that remembers a command we no longer have, and an option we dropped, is a breaking change.
    const contract = JSON.parse(readFileSync(committed, "utf8")) as { name: string; args: string[]; options: string[] }[];
    const altered = [...contract.map((c) => (c.name === "why" ? { ...c, options: [...c.options, "--deep"] } : c)), { name: "explain", args: ["<id>"], options: [] }];
    const alteredPath = join(tmp, "altered.json");
    writeFileSync(alteredPath, JSON.stringify(altered));
    const bad = runCli(["--json", "gate", "--against", alteredPath], { cwd: dir });
    assert.equal(bad.status, 1);
    const report = bad.json as { breaking: string[]; additive: string[] };
    assert.ok(report.breaking.some((b) => b.startsWith("command removed: explain")));
    assert.ok(report.breaking.some((b) => b.includes("why --deep")));
    // A snapshot missing a command we have is merely additive.
    const older = contract.filter((c) => c.name !== "kpi");
    const olderPath = join(tmp, "older.json");
    writeFileSync(olderPath, JSON.stringify(older));
    const add = runCli(["--json", "gate", "--against", olderPath], { cwd: dir });
    assert.equal(add.status, 0);
    assert.ok((add.json as { additive: string[] }).additive.includes("command added: kpi"));
  } finally {
    cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});
