import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, tempToy } from "../helpers.js";

const SESSION = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const V1 = "proc_tablecount01";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function startTurn(dir: string, prompt: string): void {
  const r = runCli(["hooks", "run", "UserPromptSubmit"], { cwd: dir, input: JSON.stringify({ cwd: dir, session_id: SESSION, hook_event_name: "UserPromptSubmit", prompt }) });
  assert.equal(r.status, 0, r.stderr);
}

/** A paper whose participant-flow table groups thousands with commas: the fixture procedure reads "1,200" as 1. */
const P05 = `# P05. A large pragmatic trial

## Methods
### Outcomes
The primary outcome was all-cause hospital admission at 12 months.

## Results
Table 1. Participant flow by arm

| Arm | Randomised | Analysed (ITT) |
|---|---|---|
| Intervention | 1,200 | 1,150 |
| Control | 1,180 | 1,130 |
`;

/** The fixture procedure, with one change: digits grouped by commas are read as one number. */
const V2_SCRIPT = `#!/usr/bin/env python3
"""Sum a numeric column of the first markdown table in a file, excluding any row labelled Total.
Digits grouped with commas (1,200) are read as one number."""
import json
import re
import sys


def main() -> int:
    path, wanted = sys.argv[1], sys.argv[2].lower()
    rows = [l.strip() for l in open(path, encoding="utf-8") if l.strip().startswith("|")]
    if len(rows) < 2:
        print(json.dumps({"error": "no markdown table found"}))
        return 2
    header = [c.strip() for c in rows[0].strip("|").split("|")]
    idx = next((i for i, h in enumerate(header) if wanted in h.lower()), None)
    if idx is None:
        print(json.dumps({"error": f"no column matching {wanted!r}", "header": header}))
        return 2
    out, total = [], 0
    for line in rows[2:]:
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells or cells[0].lower() == "total":
            continue
        cell = re.sub(r"(?<=\\d),(?=\\d{3}\\b)", "", cells[idx]) if idx < len(cells) else ""
        m = re.search(r"-?\\d+", cell)
        if not m:
            continue
        value = int(m.group())
        out.append([cells[0], value])
        total += value
    print(json.dumps({"column": header[idx], "rows": out, "total": total}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

/** A careless rewrite: reads only the first arm. */
const V3_SCRIPT = V2_SCRIPT.replace("for line in rows[2:]:", "for line in rows[2:3]:");

function addPaper(dir: string, name: string, text: string): string {
  writeFileSync(join(dir, "corpus", `${name}.md`), text);
  const art = runCli(["--json", "add", "artifact", "--json-in", JSON.stringify({ title: `${name} report`, path: `corpus/${name}.md`, sha256: sha(join(dir, "corpus", `${name}.md`)) })], { cwd: dir });
  assert.equal(art.status, 0, art.stdout);
  return (art.json as { id: string }).id;
}

/** One leaf episode that runs a procedure on a paper, records the value it gives and shows it to the researcher. */
function countWith(dir: string, proc: string, paper: string, value: number, extraUses: string[] = [], status: "active" | "proposed" = "active"): { ep: string; ev: string; dec: string } {
  const ep = runCli(["--json", "episode", "open", `${paper} n_randomized_total`, "--resolution", "code", "--uses", proc, ...extraUses, "dec_crit0random2"], { cwd: dir });
  assert.equal(ep.status, 0, ep.stdout);
  const epId = (ep.json as { id: string }).id;
  const entry = (runCli(["--json", "get", proc], { cwd: dir }).json as { entrypoint: string }).entrypoint;
  const run = runCli(["--json", "run", `python3 ${entry} corpus/${paper}.md Randomised`, "--episode", epId], { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const evId = (run.json as { evidence: string }).evidence;
  const dec = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: `${paper} n_randomized_total`, kind: "annotation", status, claim: `${value} randomised`, qualifier: { confidence: 0.9, scope: paper }, fragility: "mechanical", target: { unit: paper, field: "n_randomized_total", value }, data: [evId], warrant: ["dec_crit0random2"], depends_on: [proc], produced_by: epId })], { cwd: dir });
  assert.equal(dec.status, 0, dec.stdout);
  const decId = (dec.json as { id: string }).id;
  assert.equal(runCli(["episode", "close", epId, "--produces", evId, decId], { cwd: dir }).status, 0);
  assert.equal(runCli(["shown", decId], { cwd: dir }).status, 0);
  return { ep: epId, ev: evId, dec: decId };
}

/** Write a rewrite under procedures/<name>/ with its own copy of the P01 regression case, and register it. */
function registerRewrite(dir: string, name: string, script: string, extra: Record<string, unknown>, withCase = true): { status: number; stdout: string; json: unknown } {
  mkdirSync(join(dir, "procedures", name, "cases"), { recursive: true });
  writeFileSync(join(dir, "procedures", name, "run.py"), script);
  if (withCase) writeFileSync(join(dir, "procedures", name, "cases", "p01.json"), readFileSync(join(dir, "procedures", "table_counts", "cases", "p01.json")));
  return runCli(["--json", "add", "procedure", "--json-in", JSON.stringify({ title: `Sum a table column (${name})`, resolution: "code", entrypoint: `procedures/${name}/run.py`, applicability: ["markdown table with per-arm rows"], abstain_when: ["counts only in prose or figures"], regression_cases: withCase ? [`procedures/${name}/cases/p01.json`] : [], ...extra })], { cwd: dir });
}

test("code that produced a result never changes: the entrypoint is hashed at registration, an in-place edit invalidates the store, rehash is allowed only before use", () => {
  const { dir, cleanup } = tempToy();
  try {
    const fixture = runCli(["--json", "get", V1], { cwd: dir }).json as { code_hash: string };
    assert.equal(fixture.code_hash, sha(join(dir, "procedures", "table_counts", "run.py")));
    const added = registerRewrite(dir, "table_counts_v2", V2_SCRIPT, {});
    assert.equal(added.status, 0, added.stdout);
    const v2 = (added.json as { id: string; code_hash: string }).id;
    assert.equal((added.json as { code_hash: string }).code_hash, sha(join(dir, "procedures", "table_counts_v2", "run.py")), "add fills the hash from the file");
    // A typo fixed before anyone used the procedure: the store notices, and rehash re-registers the code.
    writeFileSync(join(dir, "procedures", "table_counts_v2", "run.py"), `${V2_SCRIPT}\n# comment\n`);
    const broken = runCli(["--json", "validate"], { cwd: dir });
    assert.equal(broken.status, 2);
    assert.ok((broken.json as { issues: { code: string; id: string }[] }).issues.some((i) => i.code === "E_PROCEDURE_HASH" && i.id === v2), broken.stdout);
    const rehash = runCli(["--json", "procedure", "rehash", v2], { cwd: dir });
    assert.equal(rehash.status, 0, rehash.stdout);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    // Once it produced a result, the same edit is refused: the new version is a new procedure.
    startTurn(dir, "Annotate P02 with the new script");
    countWith(dir, v2, "P02", 84);
    writeFileSync(join(dir, "procedures", "table_counts_v2", "run.py"), `${V2_SCRIPT}\n# a second edit\n`);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 2);
    const refused = runCli(["--json", "procedure", "rehash", v2], { cwd: dir });
    assert.equal(refused.status, 2);
    assert.match(refused.stdout, /never changes/);
    assert.match(refused.stdout, /supersedes/);
    writeFileSync(join(dir, "procedures", "table_counts_v2", "run.py"), `${V2_SCRIPT}\n# comment\n`);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0, "restoring the registered code makes the store valid again");
    // run records which machine, not only which platform.
    const ev = runCli(["--json", "ls", "evidence"], { cwd: dir }).json as { id: string }[];
    const execs = ev.map((e) => runCli(["--json", "get", e.id], { cwd: dir }).json as { execution: { host: string | null } | null }).filter((e) => e.execution && e.execution.host);
    assert.ok(execs.length > 0);
    assert.match(execs[0]!.execution!.host!, /^[0-9a-f]{12}$/);
  } finally {
    cleanup();
  }
});

test("a rewrite must say why, with evidence: supersedes without a justification is rejected, and a supersession cycle too", () => {
  const { dir, cleanup } = tempToy();
  try {
    const bare = registerRewrite(dir, "table_counts_v2", V2_SCRIPT, { supersedes: [V1] });
    assert.equal(bare.status, 2, bare.stdout);
    assert.match(bare.stdout, /E_UNJUSTIFIED_SUPERSESSION/);
    const prose = registerRewrite(dir, "table_counts_v2", V2_SCRIPT, { supersedes: [V1], justification: { kind: "performance", evidence: [], text: "it was slow" } });
    assert.equal(prose.status, 2, "text alone is not a justification");
    const ok = registerRewrite(dir, "table_counts_v2", V2_SCRIPT, { supersedes: [V1], justification: { kind: "correctness", evidence: ["dec_p01nrand0000"], text: "reads grouped digits" } });
    assert.equal(ok.status, 0, ok.stdout);
    const v2 = (ok.json as { id: string }).id;
    const cycle = runCli(["--json", "link", V1, "supersedes", v2], { cwd: dir });
    assert.equal(cycle.status, 2, cycle.stdout);
    assert.match(cycle.stdout, /E_CYCLE/);
    const why = runCli(["--json", "why", v2], { cwd: dir }).json as { children: { rel: string; node: { id: string } }[] };
    assert.ok(why.children.some((c) => c.rel === "supersedes" && c.node.id === V1));
    assert.ok(why.children.some((c) => c.rel === "justification" && c.node.id === "dec_p01nrand0000"));
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
  } finally {
    cleanup();
  }
});

test("a rewrite replaces the old procedure only when it is trusted, dominates every recorded case and clears the declared thresholds; the old record stays and its code is archived later by gc", () => {
  const { dir, cleanup } = tempToy();
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    startTurn(dir, "Annotate P02, P03 and P05");
    // The old procedure earns trust on P02 and P03, then gets P05 wrong: 1,200 and 1,180 read as 1 and 1.
    const p02 = countWith(dir, V1, "P02", 84);
    const p03 = countWith(dir, V1, "P03", 150);
    assert.equal((runCli(["--json", "get", V1], { cwd: dir }).json as { state: string }).state, "trusted");
    addPaper(dir, "P05", P05);
    const p05 = countWith(dir, V1, "P05", 2);
    assert.match(readFileSync(join(dir, "knowledge", "evidence", `${p05.ev}.md`), "utf8"), /"total": 2\b/);
    const corr = runCli(["--json", "correct", p05.dec, "--reason", "thousands are grouped with commas: 1,200 + 1,180", "--value", "2380"], { cwd: dir });
    assert.equal(corr.status, 0, corr.stdout);
    const replacement = (corr.json as { replacement: string }).replacement;
    assert.equal((runCli(["--json", "get", V1], { cwd: dir }).json as { state: string }).state, "suspended");

    // The rewrite is registered as a new procedure that names what it replaces and why.
    const reg = registerRewrite(dir, "table_counts_v2", V2_SCRIPT, { supersedes: [V1], justification: { kind: "correctness", evidence: [replacement], text: "digits grouped with commas were read as a single digit" } });
    assert.equal(reg.status, 0, reg.stdout);
    const v2 = (reg.json as { id: string }).id;

    // Compare before any trust: the comparison itself is deterministic and recorded.
    const cmp = runCli(["--json", "procedure", "compare", V1, v2], { cwd: dir });
    assert.equal(cmp.status, 0, cmp.stdout);
    const report = cmp.json as { dominates: boolean; counts: Record<string, number>; cases: { key: string; verdict: string; basis: string }[]; evidence: string; improvement: string[]; blocking: string[]; old_runs_here: boolean };
    assert.equal(report.dominates, true, JSON.stringify(report.cases));
    assert.equal(report.counts.regression, 0);
    assert.equal(report.counts.fixed, 1);
    assert.equal(report.cases.find((c) => c.key === p05.ev)?.verdict, "fixed");
    assert.equal(report.cases.find((c) => c.key === p02.ev)?.verdict, "same");
    assert.equal(report.cases.find((c) => c.key === p03.ev)?.verdict, "same");
    assert.equal(report.cases.find((c) => c.key === "ev_p01execrand0")?.verdict, "same", "the fixture's recorded execution is part of the battery");
    assert.equal(report.cases.find((c) => c.key === "procedures/table_counts/cases/p01.json")?.verdict, "same");
    assert.equal(report.old_runs_here, true);
    assert.match(report.improvement[0] ?? "", /fixes 1 case/);
    const cmpEv = runCli(["--json", "get", report.evidence], { cwd: dir }).json as { kind: string; execution: { command: string; input_hashes: Record<string, string> }; body: string };
    assert.equal(cmpEv.kind, "execution");
    assert.match(cmpEv.execution.command, /procedure compare/);
    assert.ok(cmpEv.execution.input_hashes["procedures/table_counts_v2/run.py"]);
    assert.match(cmpEv.body, /"dominates": true/);

    // A careless rewrite is not better, it is different: the researcher gets the diverging cases.
    const bad = registerRewrite(dir, "table_counts_v3", V3_SCRIPT, { supersedes: [V1], justification: { kind: "correctness", evidence: [replacement], text: "rewritten from scratch" } }, false);
    const v3 = (bad.json as { id: string }).id;
    const badReport = runCli(["--json", "procedure", "compare", V1, v3, "--no-record"], { cwd: dir }).json as { dominates: boolean; counts: Record<string, number>; blocking: string[] };
    assert.equal(badReport.dominates, false);
    assert.ok((badReport.counts["regression"] ?? 0) >= 3, JSON.stringify(badReport.counts));
    assert.match(badReport.blocking.join(" "), /regression/);

    // Not trusted yet: the replacement waits. Shadow advice appears in the ladder meanwhile.
    const early = runCli(["--json", "procedure", "supersede", v2], { cwd: dir });
    assert.equal(early.status, 2);
    assert.match(early.stdout, /not trusted/);
    const ladder = runCli(["--json", "resolve", "--unit", "P06", "--field", "n_randomized_total"], { cwd: dir }).json as { shadow: { old: string; new: string }[]; advice: string };
    assert.deepEqual(ladder.shadow, [], "the old procedure is suspended, so nothing runs in its shadow yet");

    // The rewrite earns trust on its own results: P05 redone (the researcher's replacement already holds the cell, so this one stays proposed), then two new papers.
    countWith(dir, v2, "P05", 2380, [], "proposed");
    addPaper(dir, "P06", readFileSync(join(dir, "corpus", "P02.md"), "utf8").replace("# P02.", "# P06."));
    addPaper(dir, "P07", readFileSync(join(dir, "corpus", "P03.md"), "utf8").replace("# P03.", "# P07."));
    countWith(dir, v2, "P06", 84);
    countWith(dir, v2, "P07", 150);
    assert.equal((runCli(["--json", "get", v2], { cwd: dir }).json as { state: string }).state, "trusted");

    // A threshold the researcher declared as a criterion: no corrections over at least five observed outputs.
    const crit = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: "Criterion: counting procedures make no observed error", kind: "criterion", status: "active", claim: "A counting procedure replaces another only with zero corrections over at least five observed outputs.", qualifier: { confidence: 1, scope: "procedures of this store" }, fragility: "mechanical", threshold: { metric: "observed_error_rate", max: 0, min_shown: 5 } })], { cwd: dir });
    assert.equal(crit.status, 0, crit.stdout);
    const critId = (crit.json as { id: string }).id;
    const notAnnotation = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: "x", kind: "choice", status: "active", claim: "c", qualifier: { confidence: 1 }, fragility: "mechanical", threshold: { metric: "observed_error_rate", max: 0 } })], { cwd: dir });
    assert.equal(notAnnotation.status, 2, "only criteria carry thresholds");
    const card = runCli(["--json", "procedure", "scorecard", v2], { cwd: dir }).json as { outputs: { shown: number; corrected: number; observed_error_rate: number }; thresholds: { status: string; observed: number }[]; supersedes: string[]; latency: { n: number }[]; code_versions: string[] };
    assert.equal(card.outputs.shown, 3);
    assert.equal(card.outputs.corrected, 0);
    assert.equal(card.outputs.observed_error_rate, 0);
    assert.equal(card.thresholds[0]?.status, "insufficient");
    assert.deepEqual(card.supersedes, [V1]);
    assert.equal(card.code_versions.length, 1);
    assert.ok(card.latency.some((g) => g.n === 3));
    const tooFew = runCli(["--json", "procedure", "supersede", v2], { cwd: dir });
    assert.equal(tooFew.status, 2);
    assert.match(tooFew.stdout, /insufficient/);
    assert.equal(runCli(["--json", "set", critId, "--json-in", JSON.stringify({ threshold: { min_shown: 3 } })], { cwd: dir }).status, 0);

    // Now everything holds: trusted, dominant, threshold met.
    const done = runCli(["--json", "procedure", "supersede", v2], { cwd: dir });
    assert.equal(done.status, 0, done.stdout);
    const result = done.json as { old: string; new: string; decision: string; comparison: string; thresholds: { status: string }[] };
    assert.equal(result.old, V1);
    assert.deepEqual(result.thresholds.map((t) => t.status), ["met"]);
    const old = runCli(["--json", "get", V1], { cwd: dir }).json as { state: string; history: { to: string; reason: string }[] };
    assert.equal(old.state, "superseded");
    assert.match(old.history[old.history.length - 1]!.reason, new RegExp(`superseded by ${v2}`));
    const choice = runCli(["--json", "get", result.decision], { cwd: dir }).json as { kind: string; data: string[]; warrant: string[]; depends_on: string[]; backing: string[] };
    assert.equal(choice.kind, "choice");
    assert.deepEqual(choice.data, [result.comparison]);
    assert.deepEqual(choice.warrant, [critId]);
    assert.deepEqual(choice.depends_on, [V1, v2]);
    assert.deepEqual(choice.backing, [replacement]);
    const transition = (runCli(["--json", "get", result.decision], { cwd: dir }).json as { transition: { procedure: string; to: string; reason: string } }).transition;
    assert.equal(transition.procedure, V1);
    assert.equal(transition.to, "superseded");
    assert.match(transition.reason, new RegExp(`^superseded by ${v2}`));
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    // The old procedure left the ladder; its past outputs still explain themselves.
    const after = runCli(["--json", "resolve", "--unit", "P08", "--field", "n_randomized_total"], { cwd: dir }).json as { mode: string; trusted_procedures: { id: string }[] };
    assert.equal(after.mode, "code");
    assert.deepEqual(after.trusted_procedures.map((p) => p.id), [v2]);
    const why = runCli(["--json", "why", "P01/n_randomized_total"], { cwd: dir }).json as { children: { rel: string; node: { children: { rel: string; node: { id: string; status?: string } }[] } }[] };
    const producedBy = why.children.find((c) => c.rel === "produced_by")!.node;
    assert.ok(producedBy.children.some((c) => c.rel === "uses" && c.node.id === V1 && c.node.status === "superseded"));
    const affected = (runCli(["--json", "affected", V1], { cwd: dir }).json as { id: string }[]).map((r) => r.id);
    assert.ok(affected.includes(result.decision), "the supersession decision depends on the old procedure");
    const kpi = runCli(["--json", "kpi"], { cwd: dir }).json as { procedures: { by_state: Record<string, number> } };
    assert.equal(kpi.procedures.by_state["superseded"], 1);
    // A later correction of an old output counts but moves nothing: the procedure is already out of use.
    const late = runCli(["--json", "correct", p02.dec, "--reason", "late doubt"], { cwd: dir }).json as { suspended: string[] };
    assert.deepEqual(late.suspended, []);
    assert.equal((runCli(["--json", "get", V1], { cwd: dir }).json as { state: string }).state, "superseded");
    // Changing the threshold criterion puts the supersession under review, like any decision that cited it.
    const critChange = runCli(["--json", "correct", critId, "--reason", "we now require ten observed outputs"], { cwd: dir }).json as { needs_review: string[] };
    assert.ok(critChange.needs_review.includes(result.decision));

    // Discontinuing later: gc archives the code of the superseded procedure, never its record.
    const plan = runCli(["--json", "gc", "--cold-after", "0"], { cwd: dir }).json as { code_archive: { id: string; remove: string[] }[] };
    assert.deepEqual(plan.code_archive.map((c) => c.id), [V1]);
    assert.deepEqual(plan.code_archive[0]!.remove, ["procedures/table_counts"], "the directory is nobody else's");
    const apply = runCli(["--json", "gc", "--apply", "--cold-after", "0"], { cwd: dir });
    assert.equal(apply.status, 0, apply.stdout);
    assert.deepEqual((apply.json as { result: { code_archived: string[] } }).result.code_archived, [V1]);
    assert.ok(!existsSync(join(dir, "procedures", "table_counts")));
    assert.ok(existsSync(join(dir, "knowledge", "procedures", `${V1}.md`)), "the record stays: every old value points at it");
    const archived = runCli(["--json", "get", V1], { cwd: dir }).json as { code_archived: { commit: string; removed: string[] } };
    assert.match(git(dir, "show", `${archived.code_archived.commit}:procedures/table_counts/run.py`), /Sum a numeric column/);
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    assert.equal(runCli(["--json", "procedure", "scorecard", V1], { cwd: dir }).status, 0);
    const again = runCli(["--json", "gc", "--apply", "--cold-after", "0"], { cwd: dir }).json as { result: { code_archived: string[]; swept: number } };
    assert.deepEqual(again.result.code_archived, []);
    assert.equal(git(dir, "status", "--porcelain"), "");
    // The replacement still runs: check re-runs its cases and skips the archived one.
    const check = runCli(["--json", "check"], { cwd: dir }).json as { ok: boolean; procedures: { checked: string[]; suspended: unknown[] } };
    assert.equal(check.ok, true);
    assert.ok(check.procedures.checked.includes(v2));
    assert.ok(!check.procedures.checked.includes(V1));
    assert.deepEqual(check.procedures.suspended, []);
  } finally {
    cleanup();
  }
});
