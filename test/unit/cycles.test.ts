import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

test("link and set refuse an edge that closes a cycle, and nothing of it reaches the files", () => {
  const { dir, cleanup } = tempToy();
  try {
    const forward = runCli(["--json", "link", "dec_p01nanal0000", "depends_on", "dec_p01nrand0000"], { cwd: dir });
    assert.equal(forward.status, 0, forward.stdout);
    const back = runCli(["--json", "link", "dec_p01nrand0000", "depends_on", "dec_p01nanal0000"], { cwd: dir });
    assert.equal(back.status, 2, back.stdout);
    assert.match(back.stdout, /E_CYCLE/);
    assert.match(back.stdout, /dec_p01nanal0000 -> dec_p01nrand0000 -> dec_p01nanal0000|dec_p01nrand0000 -> dec_p01nanal0000 -> dec_p01nrand0000/);
    const self = runCli(["--json", "link", "dec_p01outcm0000", "depends_on", "dec_p01outcm0000"], { cwd: dir });
    assert.equal(self.status, 2, self.stdout);
    assert.match(self.stdout, /E_CYCLE/);
    const supersedesSelf = runCli(["--json", "link", "dec_crit0random2", "supersedes", "dec_crit0random2"], { cwd: dir });
    assert.equal(supersedesSelf.status, 2, supersedesSelf.stdout);
    assert.match(supersedesSelf.stdout, /E_CYCLE/);
    const parentCycle = runCli(["--json", "set", "ep_p01root00000", "--json-in", JSON.stringify({ parent: "ep_p01nanal0000" })], { cwd: dir });
    assert.equal(parentCycle.status, 2, parentCycle.stdout);
    assert.match(parentCycle.stdout, /E_CYCLE/);
    const rand = runCli(["--json", "get", "dec_p01nrand0000"], { cwd: dir }).json as { depends_on: string[] };
    assert.deepEqual(rand.depends_on, []);
    const root = runCli(["--json", "get", "ep_p01root00000"], { cwd: dir }).json as { parent: string | null };
    assert.equal(root.parent, null);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});
