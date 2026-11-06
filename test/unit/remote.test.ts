import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const REMOTE = "toy:dec_abcdefghjkmn";

test("a decision can depend on a record of another store: the reference is typed, indexed as relying, shown as a boundary and reachable through affected", () => {
  const { dir, cleanup } = tempToy();
  try {
    const link = runCli(["--json", "link", "dec_p01nrand0000", "depends_on", `${REMOTE}@deadbeef`], { cwd: dir });
    assert.equal(link.status, 0, link.stdout);
    const dec = runCli(["--json", "get", "dec_p01nrand0000"], { cwd: dir }).json as { depends_on: unknown[] };
    assert.deepEqual(dec.depends_on, [{ store: "toy", id: "dec_abcdefghjkmn", commit: "deadbeef" }]);
    assert.equal(runCli(["--json", "link", "dec_p01nrand0000", "depends_on", REMOTE], { cwd: dir }).status, 0);
    assert.equal((runCli(["--json", "get", "dec_p01nrand0000"], { cwd: dir }).json as { depends_on: unknown[] }).depends_on.length, 1, "the same remote record is not linked twice");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0, "a remote reference is never dangling here");
    const dump = runCli(["index", "--dump"], { cwd: dir }).stdout;
    assert.ok(dump.includes(`{"src":"dec_p01nrand0000","rel":"depends_on_remote","dst":"${REMOTE}","relies":1}`), "the remote edge relies");
    const affected = runCli(["--json", "affected", REMOTE], { cwd: dir }).json as { id: string; depth: number }[];
    assert.ok(affected.some((r) => r.id === "dec_p01nrand0000" && r.depth === 1), JSON.stringify(affected));
    const why = runCli(["--json", "why", "dec_p01nrand0000"], { cwd: dir }).json as { children: { rel: string; node: { id: string; type: string; remote?: { store: string; id: string; commit: string | null }; children: unknown[] } }[] };
    const boundary = why.children.find((c) => c.rel === "depends_on_remote");
    assert.ok(boundary, "why shows the boundary");
    assert.deepEqual(boundary!.node.remote, { store: "toy", id: "dec_abcdefghjkmn", commit: "deadbeef" });
    assert.equal(boundary!.node.type, "decision");
    assert.deepEqual(boundary!.node.children, []);
    assert.match(runCli(["why", "dec_p01nrand0000"], { cwd: dir }).stdout, /toy:dec_abcdefghjkmn \(remote decision, store toy, commit deadbeef\) not followed/);
    assert.equal(runCli(["render"], { cwd: dir }).status, 0);
    assert.match(readFileSync(join(dir, "review.html"), "utf8"), /toy:dec_abcdefghjkmn/);
    // The forms the schema does not admit.
    const warrant = runCli(["--json", "link", "dec_p01nrand0000", "warrant", REMOTE], { cwd: dir });
    assert.equal(warrant.status, 2, "a warrant is a criterion of this store");
    const single = runCli(["--json", "link", "dec_p01nrand0000", "produced_by", REMOTE], { cwd: dir });
    assert.equal(single.status, 1);
  } finally {
    cleanup();
  }
});
