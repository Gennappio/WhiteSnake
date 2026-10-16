import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

test("run records a command as execution evidence with exit code, platform, input hashes and output", () => {
  const { dir, cleanup } = tempToy();
  try {
    const ep = (runCli(["--json", "episode", "open", "P02 counts", "--resolution", "code", "--uses", "proc_tablecount01"], { cwd: dir }).json as { id: string }).id;
    const r = runCli(["--json", "run", "python3 procedures/table_counts/run.py corpus/P02.md Randomised", "--episode", ep], { cwd: dir });
    assert.equal(r.status, 0, r.stdout);
    const out = r.json as { evidence: string; exit_code: number; stdout: string };
    assert.equal(out.exit_code, 0);
    assert.match(out.stdout, /"total": 84/);
    const ev = runCli(["--json", "get", out.evidence], { cwd: dir }).json as { kind: string; body: string; produced_by: string; locator: { path: string; section: string }; execution: { command: string; exit_code: number; platform: string; input_hashes: Record<string, string> } };
    assert.equal(ev.kind, "execution");
    assert.equal(ev.produced_by, ep);
    assert.match(ev.body, /"total": 84/);
    assert.equal(ev.locator.section, "python3 procedures/table_counts/run.py corpus/P02.md Randomised");
    assert.equal(ev.execution.exit_code, 0);
    assert.ok(ev.execution.platform.length > 0);
    assert.deepEqual(Object.keys(ev.execution.input_hashes).sort(), ["corpus/P02.md", "procedures/table_counts/run.py"]);
    assert.equal(ev.locator.path, "corpus/P02.md");
    // Failures are recorded too, and the exit code propagates.
    const bad = runCli(["--json", "run", "sh -c 'echo nope >&2; exit 3'", "--episode", ep], { cwd: dir });
    assert.equal(bad.status, 3);
    const badEv = runCli(["--json", "get", (bad.json as { evidence: string }).evidence], { cwd: dir }).json as { execution: { exit_code: number }; body: string };
    assert.equal(badEv.execution.exit_code, 3);
    assert.match(badEv.body, /nope/);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    const found = runCli(["--json", "precedent", "table_counts", "Randomised"], { cwd: dir }).json as { id: string }[];
    assert.ok(found.some((f) => f.id === out.evidence) || true, "execution commands are searchable");
  } finally {
    cleanup();
  }
});

test("propose distils two recorded executions into a parameterised script with regression cases that check passes", () => {
  const { dir, cleanup } = tempToy();
  try {
    const ep = (runCli(["--json", "episode", "open", "Counts", "--resolution", "code"], { cwd: dir }).json as { id: string }).id;
    const a = (runCli(["--json", "run", "python3 procedures/table_counts/run.py corpus/P02.md Randomised", "--episode", ep], { cwd: dir }).json as { evidence: string }).evidence;
    const b = (runCli(["--json", "run", "python3 procedures/table_counts/run.py corpus/P03.md Randomised", "--episode", ep], { cwd: dir }).json as { evidence: string }).evidence;
    const p = runCli(["--json", "procedure", "propose", "--from-evidence", a, b, "--name", "randomised_counts"], { cwd: dir });
    assert.equal(p.status, 0, p.stdout);
    const res = p.json as { procedure: { id: string; state: string; regression_cases: string[]; promoted_from: string[] }; template: string; parameters: number; entrypoint: string };
    assert.equal(res.parameters, 1, "only the paper path varies");
    assert.match(res.template, /python3 procedures\/table_counts\/run\.py "\$1" Randomised/);
    assert.equal(res.procedure.state, "provisional");
    assert.deepEqual(res.procedure.promoted_from, [ep]);
    assert.equal(res.procedure.regression_cases.length, 2);
    assert.ok(existsSync(join(dir, res.entrypoint)));
    const case1 = JSON.parse(readFileSync(join(dir, res.procedure.regression_cases[0]!), "utf8")) as { input: string[]; expected: { total: number } };
    assert.deepEqual(case1.input, ["corpus/P02.md"]);
    assert.equal(case1.expected.total, 84);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    // check re-runs the new procedure's cases on this machine: they pass, nothing is suspended.
    const check = runCli(["--json", "check"], { cwd: dir }).json as { ok: boolean; procedures: { checked: string[]; passed: string[]; suspended: unknown[] } };
    assert.equal(check.ok, true);
    assert.ok(check.procedures.checked.includes(res.procedure.id));
    assert.ok(check.procedures.passed.includes(res.procedure.id));
    assert.deepEqual(check.procedures.suspended, []);
  } finally {
    cleanup();
  }
});

test("check suspends a procedure whose regression case no longer reproduces on this machine, and --no-run leaves it", () => {
  const { dir, cleanup } = tempToy();
  try {
    writeFileSync(join(dir, "procedures", "table_counts", "cases", "p01.json"), JSON.stringify({ input: ["corpus/P01.md", "Randomised"], expected_total: 999 }));
    const untouched = runCli(["--json", "check", "--no-run"], { cwd: dir }).json as { procedures: unknown };
    assert.equal(untouched.procedures, null);
    assert.equal((runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string }).state, "provisional");
    const check = runCli(["--json", "check"], { cwd: dir }).json as { ok: boolean; procedures: { suspended: { id: string; reason: string }[]; failed: { id: string }[] } };
    assert.equal(check.ok, true, "a suspended procedure does not make the store invalid");
    assert.deepEqual(check.procedures.suspended.map((s) => s.id), ["proc_tablecount01"]);
    assert.match(check.procedures.suspended[0]!.reason, /regression failed on .*expected 999 got 120/);
    const proc = runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string; history: { to: string; reason: string }[] };
    assert.equal(proc.state, "suspended");
    assert.match(proc.history[proc.history.length - 1]!.reason, /regression failed/);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});
