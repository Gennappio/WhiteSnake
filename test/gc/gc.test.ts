import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, REPO_ROOT, runCli, tempToy } from "../helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const gitInit = (dir: string) => {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
};
const stubEnv = { WHITESNAKE_STUB_SCRIPT: join(FIXTURES, "stub-agent.sh"), PATH: `${join(REPO_ROOT, "bin")}:${process.env["PATH"] ?? ""}` };

/** A cold, failed root episode with its own evidence: the kind of attempt gc compacts into a negative example. */
function plantGarbage(dir: string): { ep: string; ev: string } {
  const ep = runCli(["--json", "add", "episode", "--json-in", JSON.stringify({ title: "Try reading counts from the figure", resolution: "agent", caused_by: "turn_claude_toyseed0001_0001", started: "2026-10-01T09:30:00.000Z", ended: "2026-10-01T09:35:00.000Z", outcome: "failure" }), "--body", "The figure has no readable numbers; abandoned."], { cwd: dir });
  assert.equal(ep.status, 0, ep.stdout);
  const epId = (ep.json as { id: string }).id;
  const ev = runCli(["--json", "add", "evidence", "--json-in", JSON.stringify({ title: "Figure 1 caption", kind: "excerpt", locator: { artifact: "art_p01a7k3m9q2x", section: "Figure 1" }, produced_by: epId, caused_by: "turn_claude_toyseed0001_0001" }), "--body", "Figure 1. Participant flow."], { cwd: dir });
  assert.equal(ev.status, 0, ev.stdout);
  return { ep: epId, ev: (ev.json as { id: string }).id };
}

test("gc leaves a clean store alone and compacts only cold subtrees nothing live needs, reversibly", () => {
  const { dir, cleanup } = tempToy();
  try {
    gitInit(dir);
    const empty = runCli(["--json", "gc", "--cold-after", "0"], { cwd: dir }).json as { sweep: unknown[] };
    assert.equal(empty.sweep.length, 0, "P01's subtree is needed by live decisions and procedures");
    const g = plantGarbage(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "garbage");
    const before = runCli(["--json", "why", "P01/n_analyzed_total"], { cwd: dir }).json;
    const notYet = runCli(["--json", "gc"], { cwd: dir }).json as { sweep: unknown[] };
    assert.equal(notYet.sweep.length, 0, "with the default age the single-session store is not cold yet");
    const plan = runCli(["--json", "gc", "--cold-after", "0"], { cwd: dir }).json as { sweep: { id: string }[]; templates: { ids: string[]; negative_examples: number }[] };
    assert.deepEqual(plan.sweep.map((s) => s.id).sort(), [g.ep, g.ev].sort());
    assert.equal(plan.templates.length, 1);
    assert.equal(plan.templates[0]?.negative_examples, 1);
    const head = git(dir, "rev-parse", "HEAD");
    const apply = runCli(["--json", "gc", "--apply", "--cold-after", "0"], { cwd: dir });
    assert.equal(apply.status, 0, apply.stdout);
    const result = (apply.json as { result: { swept: number; templates: string[]; commit: string } }).result;
    assert.equal(result.swept, 2);
    assert.equal(result.templates.length, 1);
    assert.ok(!existsSync(join(dir, "knowledge", "episodes", `${g.ep}.md`)));
    const tpl = runCli(["--json", "get", result.templates[0]!], { cwd: dir }).json as { compacted_from: { count: number; commit: string; ids: string[] }; negative_examples: string[]; locators: unknown[] };
    assert.equal(tpl.compacted_from.count, 2);
    assert.equal(tpl.compacted_from.commit, head);
    assert.deepEqual(tpl.compacted_from.ids, [g.ep, g.ev].sort());
    assert.match(tpl.negative_examples[0] ?? "", /no readable numbers/);
    assert.equal(tpl.locators.length, 1);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    assert.deepEqual(runCli(["--json", "why", "P01/n_analyzed_total"], { cwd: dir }).json, before, "live provenance is untouched");
    // Idempotent: a second apply changes nothing.
    const afterFirst = git(dir, "rev-parse", "HEAD");
    const again = runCli(["--json", "gc", "--apply", "--cold-after", "0"], { cwd: dir }).json as { result: { swept: number } };
    assert.equal(again.result.swept, 0);
    assert.equal(git(dir, "rev-parse", "HEAD"), afterFirst);
    // Reversible: the raw episode is still in history.
    assert.match(git(dir, "show", `${head}:knowledge/episodes/${g.ep}.md`), /abandoned/);
  } finally {
    cleanup();
  }
});

test("collapse refuses a subtree that still needs an agent and composes one that does not", () => {
  const { dir, cleanup } = tempToy();
  try {
    const refused = runCli(["--json", "collapse", "ep_p01root00000"], { cwd: dir });
    assert.equal(refused.status, 2);
    assert.match(refused.stdout, /ep_p01outcm0000/);
    // A parent whose two children were both resolved by code.
    const parent = (runCli(["--json", "episode", "open", "Counts for P02", "--resolution", "agent"], { cwd: dir }).json as { id: string }).id;
    const kids: string[] = [];
    for (const [field, value, warrant] of [["n_randomized_total", 84, "dec_crit0random2"], ["n_analyzed_total", 80, "dec_crit0analyz1"]] as const) {
      const ep = (runCli(["--json", "episode", "open", `P02 ${field}`, "--parent", parent, "--resolution", "code", "--uses", "proc_tablecount01", warrant], { cwd: dir }).json as { id: string }).id;
      const ev = (runCli(["--json", "add", "evidence", "--json-in", JSON.stringify({ title: `table_counts for ${field}`, kind: "execution", locator: { artifact: "art_p02b8n4p0r5y", section: `procedures/table_counts/run.py corpus/P02.md ${field === "n_randomized_total" ? "Randomised" : "Analysed"}` }, produced_by: ep }), "--body", `{"total": ${value}}`], { cwd: dir }).json as { id: string }).id;
      const dec = (runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: `P02 ${field}`, kind: "annotation", status: "active", claim: `${value}`, qualifier: { confidence: 0.9 }, fragility: "mechanical", target: { unit: "P02", field, value }, data: [ev], warrant: [warrant], depends_on: ["proc_tablecount01"], produced_by: ep })], { cwd: dir }).json as { id: string }).id;
      assert.equal(runCli(["episode", "close", ep, "--produces", ev, dec], { cwd: dir }).status, 0);
      kids.push(ep);
    }
    assert.equal(runCli(["--json", "set", parent, "--json-in", JSON.stringify({ children: kids, outcome: "success", ended: "2026-10-16T12:00:00.000Z" })], { cwd: dir }).status, 0);
    const collapsed = runCli(["--json", "collapse", parent], { cwd: dir });
    assert.equal(collapsed.status, 0, collapsed.stdout);
    const r = collapsed.json as { procedure: string; steps: number; entrypoint: string };
    assert.equal(r.steps, 2);
    assert.ok(existsSync(join(dir, r.entrypoint)));
    assert.match(readFileSync(join(dir, r.entrypoint), "utf8"), /Step 1[\s\S]*Step 2/);
    const proc = runCli(["--json", "get", r.procedure], { cwd: dir }).json as { state: string; uses: string[]; promoted_from: string[]; resolution: string };
    assert.equal(proc.state, "provisional");
    assert.deepEqual(proc.uses, ["proc_tablecount01"]);
    assert.deepEqual([...proc.promoted_from].sort(), [...kids].sort());
    assert.equal(proc.resolution, "skill");
    const par = runCli(["--json", "get", parent], { cwd: dir }).json as { uses: string[] };
    assert.ok(par.uses.includes(r.procedure));
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("recheck retires a procedure the model alone reproduces and keeps one it does not", () => {
  const { dir, cleanup } = tempToy();
  try {
    const easy = runCli(["--json", "procedure", "recheck", "proc_tablecount01", "--harness", "stub", "--retire"], { cwd: dir, env: stubEnv });
    assert.equal(easy.status, 0, easy.stdout);
    const e = easy.json as { all_pass: boolean; retired: boolean; cases: { pass: boolean }[] };
    assert.equal(e.all_pass, true);
    assert.equal(e.retired, true);
    assert.equal((runCli(["--json", "get", "proc_tablecount01"], { cwd: dir }).json as { state: string }).state, "retired");
    // A harder procedure: its case asks for a value the stub cannot produce.
    writeFileSync(join(dir, "procedures", "table_counts", "cases", "hard.json"), JSON.stringify({ input: ["corpus/P03.md", "Per-protocol"], expected: 131 }));
    const hard = (runCli(["--json", "add", "procedure", "--json-in", JSON.stringify({ title: "Per-protocol counts", resolution: "code", entrypoint: "procedures/table_counts/run.py", regression_cases: ["procedures/table_counts/cases/hard.json"] })], { cwd: dir }).json as { id: string }).id;
    const kept = runCli(["--json", "procedure", "recheck", hard, "--harness", "stub", "--retire"], { cwd: dir, env: stubEnv }).json as { all_pass: boolean; retired: boolean };
    assert.equal(kept.all_pass, false);
    assert.equal(kept.retired, false);
    assert.equal((runCli(["--json", "get", hard], { cwd: dir }).json as { state: string }).state, "provisional");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    assert.ok((runCli(["--json", "kpi"], { cwd: dir }).json as { transitions: { to: string }[] }).transitions.some((t) => t.to === "retired"));
  } finally {
    cleanup();
  }
});

test("gc --apply refuses without git and commits uncommitted records before compacting them", () => {
  const { dir, cleanup } = tempToy();
  try {
    const first = plantGarbage(dir);
    assert.equal(runCli(["--json", "gc", "--cold-after", "0"], { cwd: dir }).status, 0, "the plan is available without git");
    const refused = runCli(["--json", "gc", "--apply", "--cold-after", "0"], { cwd: dir });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /git repository/);
    assert.ok(existsSync(join(dir, "knowledge", "episodes", `${first.ep}.md`)), "nothing was removed");
    gitInit(dir);
    const second = plantGarbage(dir);
    assert.ok(git(dir, "status", "--porcelain").includes(second.ep), "the second attempt is not committed yet");
    const apply = runCli(["--json", "gc", "--apply", "--cold-after", "0"], { cwd: dir });
    assert.equal(apply.status, 0, apply.stdout);
    const { plan, result } = apply.json as { plan: { sweep: { id: string }[]; templates: { ids: string[] }[] }; result: { swept: number; templates: string[] } };
    assert.equal(result.swept, 4);
    assert.equal(new Set(plan.sweep.map((s) => s.id)).size, 4, "two subtrees compacted together: each record is swept once");
    assert.equal(plan.templates.length, 2);
    assert.equal(plan.templates.flatMap((t) => t.ids).length, 4, "no record is listed in two templates");
    const tpl = runCli(["--json", "get", result.templates[0]!], { cwd: dir }).json as { compacted_from: { commit: string } };
    assert.equal(git(dir, "log", "-1", "--format=%s", tpl.compacted_from.commit), "store: before gc");
    assert.match(git(dir, "show", `${tpl.compacted_from.commit}:knowledge/episodes/${second.ep}.md`), /abandoned/);
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});
