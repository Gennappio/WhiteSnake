/**
 * M3 live test: the handoff. One harness builds the store, the other inherits it in a clean directory.
 *
 *   1. producer (default claude) annotates P02 and P03; the store is exported with its manifest;
 *   2. in the exported copy, `autosoft check` passes;
 *   3. the inheritor (default codex) answers "why" questions through `autosoft ask`: the cited records must include
 *      the decision, one of its evidence records and the criterion;
 *   4. the inheritor applies a criterion change through `autosoft correct`: exactly the analysed annotations are flagged;
 *   5. the inheritor annotates the new paper P04 with complete chains, reusing the procedure;
 *   6. a parent store delegates a question to the inherited store; the answer comes back as evidence.
 *   Final messages are saved to <report>.answers.md for the researcher's judgment (correctness, avoidable questions).
 *
 *   node dist/src/e2e/m3.js [--producer claude|codex] [--inheritor codex|claude] [--producer-model M] [--inheritor-model M] [--keep]
 */
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askStore } from "../agent/ask.js";
import { delegateTask } from "../agent/delegate.js";
import { sanitizeNative, sessionIdFor } from "../schema/ids.js";
import { loadStore } from "../store/files.js";
import { TASK_PROMPT, TOY_EXTRA, chainComplete, checkCell, cleanup, cli, cliCommands, hookEvents, prepareStore, runAgent, transcriptFor, type CommonArgs, type Harness } from "./common.js";

function arg(a: string[], flag: string): string | null {
  const i = a.indexOf(flag);
  return i >= 0 ? (a[i + 1] ?? null) : null;
}

const a = process.argv.slice(2);
const producer: Harness = arg(a, "--producer") === "codex" ? "codex" : "claude";
const inheritor: Harness = arg(a, "--inheritor") === "claude" ? "claude" : "codex";
const producerArgs: CommonArgs = { harness: producer, model: arg(a, "--producer-model"), budget: 10, keep: true, settingsFlag: false };
const inheritorArgs: CommonArgs = { harness: inheritor, model: arg(a, "--inheritor-model"), budget: 10, keep: true, settingsFlag: false };
const keep = a.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "autosoft-m3-"));
const reportPath = join(scratch, "m3-report");
const answers: string[] = [];

const CRITERION_PROMPT = [
  "You inherited this store. The researcher changed a rule: n_analyzed_total must count the per-protocol population when a paper reports one, otherwise the intention-to-treat population.",
  "Record it through the store: run `autosoft correct dec_crit0analyz1 --reason \"...\"`, add the new criterion as a decision of kind criterion superseding dec_crit0analyz1, and list the annotations that now need review. Do not re-annotate yet.",
].join(" ");
const P04_PROMPT = [
  "A new paper P04 arrived at corpus/P04.md. Register its artifact, then annotate it for the three output fields following the autosoft skill:",
  "use `autosoft resolve --unit P04 --field <field>` and reuse trusted procedures where they apply, recording them in the episode's uses;",
  "capture verbatim evidence, cite the current criteria as warrant, close the episodes, run `autosoft validate` and list the decision ids you created.",
].join(" ");

function turnPrefix(h: Harness, sid: string): string {
  return `turn_${h}_${sanitizeNative(sid)}_`;
}

function main(): void {
  // 1. Producer builds the store.
  const source = prepareStore("autosoft-m3-src-");
  const sidP = randomUUID();
  const prod = runAgent(source, TASK_PROMPT, sidP, producerArgs);
  console.error(`[m3] producer ${producer} exited ${prod.status} after ${prod.seconds}s`);
  answers.push(`# Producer (${producer}) final message\n\n${String(prod.result?.["result"] ?? prod.stdout).slice(0, 4000)}`);
  const producedOk = prod.status === 0 && cli(source, ["validate"]).status === 0;
  const exportDir = join(scratch, "inherited");
  const exp = cli(source, ["export", exportDir]);
  const exportOk = exp.status === 0;
  console.error(`[m3] export ${exportOk ? "ok" : `FAILED: ${exp.stdout.slice(0, 300)}`}`);

  // 2. First open in the clean copy.
  const check = cli(exportDir, ["check"]);
  const checkOk = check.status === 0 && (check.json as { ok?: boolean } | null)?.ok === true;
  // The inherited store gets its own hooks/skill links (absolute paths differ from the source machine in general).
  cli(exportDir, ["hooks", "install"]);
  console.error(`[m3] check ${checkOk ? "ok" : "FAILED"}`);

  // 3. Why questions through ask.
  const whyTargets = ["P02/n_analyzed_total", "P03/n_analyzed_total", "P02/primary_outcome"];
  const whyResults = whyTargets.map((cell) => {
    const expectedTree = cli(exportDir, ["why", cell]).json as { id: string; children: { rel: string; node: { id: string } }[] } | null;
    const expectedDecision = expectedTree?.id ?? null;
    const expectedEvidence = expectedTree?.children.filter((c) => c.rel === "data").map((c) => c.node.id) ?? [];
    const expectedCriteria = expectedTree?.children.filter((c) => c.rel === "warrant").map((c) => c.node.id) ?? [];
    const [unit, field] = cell.split("/");
    const r = askStore(exportDir, `Why does ${unit} ${field} have the value it has? Cite the decision id, the evidence ids it rests on and the criterion that licenses it.`, { harness: inheritor, model: inheritorArgs.model, budgetUsd: 3 });
    answers.push(`# Why ${cell} (${inheritor})\n\n${r.answer}\n\nrecords: ${r.records.join(", ")}\nconfidence: ${r.confidence}`);
    const citesDecision = !!expectedDecision && r.records.includes(expectedDecision);
    const citesEvidence = expectedEvidence.some((e) => r.records.includes(e));
    const citesCriterion = expectedCriteria.some((c) => r.records.includes(c));
    return { cell, expectedDecision, citesDecision, citesEvidence, citesCriterion, confidence: r.confidence, ok: citesDecision && citesEvidence && citesCriterion };
  });
  console.error(`[m3] why: ${whyResults.filter((w) => w.ok).length}/${whyResults.length} fully cited`);

  // 4. Criterion change in the inherited store.
  const before = loadStore(exportDir).nodes;
  const analysedBefore = [...before.values()].filter((n) => n.type === "decision" && n.kind === "annotation" && n.target?.field === "n_analyzed_total").map((n) => n.id).sort();
  const othersBefore = [...before.values()].filter((n) => n.type === "decision" && n.kind === "annotation" && n.target?.field !== "n_analyzed_total").map((n) => [n.id, n.type === "decision" ? n.status : ""] as const);
  const sidC = randomUUID();
  const corr = runAgent(exportDir, CRITERION_PROMPT, sidC, inheritorArgs);
  const sessionC = corr.sessionId || sidC;
  console.error(`[m3] correction ${inheritor} exited ${corr.status} after ${corr.seconds}s`);
  answers.push(`# Criterion change (${inheritor}) final message\n\n${String(corr.result?.["result"] ?? corr.stdout).slice(0, 4000)}`);
  const tC = transcriptFor(exportDir, inheritor, sessionC);
  const commands = tC ? cliCommands(tC) : hookEvents(exportDir).commands;
  const after = loadStore(exportDir).nodes;
  const flagged = analysedBefore.map((id) => ({ id, status: (after.get(id) as { status?: string } | undefined)?.status ?? "missing" }));
  const untouched = othersBefore.every(([id, status]) => (after.get(id) as { status?: string } | undefined)?.status === status);
  const correction = {
    correct_invoked: commands.some((c) => /autosoft\s+correct\s+dec_crit0analyz1/.test(c)),
    flagged,
    untouched,
    new_criterion: [...after.values()].find((n) => n.type === "decision" && n.kind === "criterion" && n.supersedes.includes("dec_crit0analyz1"))?.id ?? null,
    validate_ok: cli(exportDir, ["validate"]).status === 0,
  };
  const correctionOk = corr.status === 0 && correction.correct_invoked && flagged.length === 3 && flagged.every((f) => f.status === "needs_review" || f.status === "superseded") && untouched && correction.validate_ok;

  // 5. New paper in the inherited store.
  cpSync(join(TOY_EXTRA, "P04.md"), join(exportDir, "corpus", "P04.md"));
  const sidN = randomUUID();
  const neu = runAgent(exportDir, P04_PROMPT, sidN, inheritorArgs);
  const sessionN = neu.sessionId || sidN;
  console.error(`[m3] P04 ${inheritor} exited ${neu.status} after ${neu.seconds}s`);
  answers.push(`# P04 annotation (${inheritor}) final message\n\n${String(neu.result?.["result"] ?? neu.stdout).slice(0, 4000)}`);
  const p04 = ["P04/n_randomized_total", "P04/n_analyzed_total", "P04/primary_outcome"].map((cell) => checkCell(exportDir, cell, sessionIdFor(inheritor, sessionN), cell.endsWith("randomized_total") ? 150 : cell.endsWith("analyzed_total") ? 144 : /hba1c/i));
  const epsN = [...loadStore(exportDir).nodes.values()].filter((n) => n.type === "episode" && n.caused_by?.startsWith(turnPrefix(inheritor, sessionN)));
  const reused = epsN.some((e) => e.type === "episode" && e.uses.includes("proc_tablecount01"));
  const p04Ok = neu.status === 0 && p04.every(chainComplete) && p04.filter((c) => c.value_ok).length >= 2 && reused && cli(exportDir, ["validate"]).status === 0;

  // 6. Delegation from a parent store to the inherited store.
  const parent = prepareStore("autosoft-m3-parent-");
  const cfgPath = join(parent, "autosoft.yaml");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/^id: toy$/m, "id: parent-lab"));
  cli(parent, ["validate"]);
  let delegation: Record<string, unknown> = {};
  let delegationOk = false;
  try {
    const d = delegateTask(parent, exportDir, { question: "How many participants were randomised in P02, and which evidence supports it?", why: "needed for a pooled total across stores", harness: inheritor, model: inheritorArgs.model, budgetUsd: 5 });
    delegation = { task: d.task.id, branch: d.branch, status: d.output?.status ?? null, result: d.output?.result ?? null, decision_ids: d.output?.decision_ids ?? [], parent_episode: d.parent_episode, parent_evidence: d.parent_evidence };
    answers.push(`# Delegation answer (${inheritor})\n\n${d.output?.result ?? "(no structured output)"}\n\ndecisions: ${(d.output?.decision_ids ?? []).join(", ")}`);
    const ev = cli(parent, ["why", d.parent_evidence]).json as { children: { rel: string }[] } | null;
    delegationOk = d.output?.status === "completed" && /84/.test(d.output.result) && !!ev && ev.children.some((c) => c.rel === "locator") && cli(parent, ["validate"]).status === 0;
  } catch (e) {
    delegation = { error: (e as Error).message };
  }
  console.error(`[m3] delegation ${delegationOk ? "ok" : "FAILED"}`);

  // Avoidable questions: lines in the inheritor's final messages that ask the user something (heuristic; the researcher judges).
  const asked = answers.filter((x) => x.includes(`(${inheritor})`)).flatMap((x) => x.split("\n").filter((l) => /\?\s*$/.test(l) && /\b(you|your|should I|do you|could you|would you)\b/i.test(l)));

  const report = {
    producer,
    inheritor,
    source,
    inherited: exportDir,
    parent,
    produced_ok: producedOk,
    export_ok: exportOk,
    check: check.json,
    check_ok: checkOk,
    why: whyResults,
    why_ok: whyResults.every((w) => w.ok),
    correction,
    correction_ok: correctionOk,
    p04: { cells: p04, reused, ok: p04Ok },
    delegation,
    delegation_ok: delegationOk,
    questions_to_user: asked,
    pass: producedOk && exportOk && checkOk && whyResults.every((w) => w.ok) && correctionOk && p04Ok && delegationOk,
  };
  writeFileSync(`${reportPath}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${reportPath}.answers.md`, `${answers.join("\n\n---\n\n")}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nM3 handoff test (${producer} -> ${inheritor}): ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`  produced=${producedOk} export=${exportOk} check=${checkOk} why=${whyResults.filter((w) => w.ok).length}/${whyResults.length} correction=${correctionOk} p04=${p04Ok} delegation=${delegationOk} questions_to_user=${asked.length}`);
  console.log(`  answers for the researcher: ${reportPath}.answers.md`);
  if (!keep) {
    cleanup(source, false);
    cleanup(parent, false);
  }
  process.exitCode = report.pass ? 0 : 1;
}

main();
