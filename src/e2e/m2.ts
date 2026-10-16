/**
 * M2 live test: three agent sessions on one store.
 *
 *   A) annotate P02 and P03: valid store, six complete chains, and the table procedure promoted to trusted
 *      by the results shown in the agent's final message;
 *   B) the researcher changes the analysed-population criterion: the agent must record it through `autosoft correct`
 *      so every n_analyzed_total annotation leaves `active`, while randomised and outcome annotations stay untouched;
 *   C) a fourth paper arrives: three complete chains, the trusted procedure is reused, no duplicate procedure.
 *
 *   node dist/src/e2e/m2.js [--harness claude|codex] [--model M] [--keep]
 */
import { randomUUID } from "node:crypto";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { sanitizeNative, sessionIdFor } from "../schema/ids.js";
import { loadStore } from "../store/files.js";
import { TASK_PROMPT, TOY_EXTRA, chainComplete, checkCell, cleanup, cli, cliCommands, hookEvents, parseCommonArgs, prepareStore, runAgent, transcriptFor, type CellReport, type CommonArgs } from "./common.js";

const CORRECTION_PROMPT = [
  "The researcher reviewed the annotations and changed a rule: from now on n_analyzed_total must count the per-protocol population",
  "when a paper reports one, and the intention-to-treat population otherwise.",
  "Record this change through the store, not by editing files: run `autosoft correct dec_crit0analyz1 --reason \"...\"` so that every",
  "annotation relying on the old criterion is flagged for review, then add the new criterion as a decision of kind criterion that supersedes",
  "dec_crit0analyz1, and finish by listing the annotations that now need review. Do not re-annotate anything yet.",
].join(" ");

const P04_PROMPT = [
  "A new paper P04 arrived at corpus/P04.md. Register its artifact, then annotate it for the three output fields following the autosoft skill:",
  "check `autosoft resolve --unit P04 --field <field>` and reuse trusted procedures where they apply, recording them in the episode's uses;",
  "capture verbatim evidence, cite the current criteria as warrant, close the episodes, run `autosoft validate` and list the decision ids you created.",
].join(" ");

const P04_EXPECTED: Record<string, number | RegExp> = {
  "P04/n_randomized_total": 150,
  "P04/n_analyzed_total": 144,
  "P04/primary_outcome": /hba1c/i,
};

interface PhaseA {
  seconds: number;
  validate_ok: boolean;
  chains: number;
  procedure_state: string | null;
  procedure_shown_uses: number | null;
  non_agent_share: number;
  pass: boolean;
}
interface PhaseB {
  seconds: number;
  correct_invoked: boolean;
  analysed_flagged: { id: string; status: string }[];
  untouched_ok: boolean;
  new_criterion: string | null;
  validate_ok: boolean;
  pass: boolean;
}
interface PhaseC {
  seconds: number;
  cells: CellReport[];
  chains: number;
  values_ok: number;
  reused_procedure: boolean;
  procedure_count_before: number;
  procedure_count_after: number;
  non_agent_share: number;
  validate_ok: boolean;
  pass: boolean;
}

function turnPrefix(harness: CommonArgs["harness"], sid: string): string {
  return `turn_${harness}_${sanitizeNative(sid)}_`;
}

function episodesOf(store: string, prefix: string) {
  return [...loadStore(store).nodes.values()].filter((n) => n.type === "episode" && n.caused_by?.startsWith(prefix) && n.outcome !== "open");
}

function nonAgentShare(store: string, prefix: string): number {
  const eps = episodesOf(store, prefix);
  if (!eps.length) return 0;
  return Math.round((eps.filter((e) => e.type === "episode" && e.resolution !== "agent").length / eps.length) * 1000) / 1000;
}

function main(): void {
  const parsed = parseCommonArgs(process.argv.slice(2));
  const args: CommonArgs = parsed;
  const store = prepareStore("autosoft-m2-");
  console.error(`[m2] store ${store} (${args.harness}${args.model ? `, ${args.model}` : ""})`);

  // Phase A
  const sidA = randomUUID();
  const runA = runAgent(store, TASK_PROMPT, sidA, args);
  const sessionA = runA.sessionId || sidA;
  console.error(`[m2] A: ${args.harness} exited ${runA.status} after ${runA.seconds}s${runA.stderr.trim() ? `; ${runA.stderr.trim().slice(0, 200)}` : ""}`);
  const nodesA = loadStore(store).nodes;
  const proc = nodesA.get("proc_tablecount01");
  const cellsA = ["P02/n_randomized_total", "P02/n_analyzed_total", "P02/primary_outcome", "P03/n_randomized_total", "P03/n_analyzed_total", "P03/primary_outcome"].map((c) => checkCell(store, c, sessionIdFor(args.harness, sessionA), null));
  const a: PhaseA = {
    seconds: runA.seconds,
    validate_ok: cli(store, ["validate"]).status === 0,
    chains: cellsA.filter(chainComplete).length,
    procedure_state: proc?.type === "procedure" ? proc.state : null,
    procedure_shown_uses: proc?.type === "procedure" ? proc.counters.shown_uses : null,
    non_agent_share: nonAgentShare(store, turnPrefix(args.harness, sessionA)),
    pass: false,
  };
  a.pass = runA.status === 0 && a.validate_ok && a.chains === 6 && a.procedure_state === "trusted";
  const untouchedBefore = new Map(cellsA.filter((c) => !c.cell.endsWith("n_analyzed_total")).map((c) => [c.cell, { id: c.decision, value: c.value, status: c.status }]));

  // Phase B
  const sidB = randomUUID();
  const runB = runAgent(store, CORRECTION_PROMPT, sidB, args);
  const sessionB = runB.sessionId || sidB;
  console.error(`[m2] B: ${args.harness} exited ${runB.status} after ${runB.seconds}s${runB.stderr.trim() ? `; ${runB.stderr.trim().slice(0, 200)}` : ""}`);
  const transcriptB = transcriptFor(store, args.harness, sessionB);
  const commandsB = transcriptB ? cliCommands(transcriptB) : hookEvents(store).commands;
  const nodesB = loadStore(store).nodes;
  const analysed = [...nodesB.values()].filter((n) => n.type === "decision" && n.kind === "annotation" && n.target?.field === "n_analyzed_total");
  const analysedOriginal = analysed.filter((n) => n.type === "decision" && !n.caused_by?.startsWith(turnPrefix(args.harness, sessionB)));
  const newCriterion = [...nodesB.values()].find((n) => n.type === "decision" && n.kind === "criterion" && n.supersedes.includes("dec_crit0analyz1"));
  const cellsAfterB = [...untouchedBefore.keys()].map((c) => checkCell(store, c, sessionIdFor(args.harness, sessionA), null));
  const b: PhaseB = {
    seconds: runB.seconds,
    correct_invoked: commandsB.some((c) => /autosoft\s+correct\s+dec_crit0analyz1/.test(c)) || hookEvents(store).commands.some((c) => /autosoft correct dec_crit0analyz1/.test(c)),
    analysed_flagged: analysedOriginal.map((n) => ({ id: n.id, status: n.type === "decision" ? n.status : "" })).sort((x, y) => x.id.localeCompare(y.id)),
    untouched_ok: cellsAfterB.every((c) => {
      const before = untouchedBefore.get(c.cell);
      return !!before && c.decision === before.id && JSON.stringify(c.value) === JSON.stringify(before.value) && c.status === "active";
    }),
    new_criterion: newCriterion?.id ?? null,
    validate_ok: cli(store, ["validate"]).status === 0,
    pass: false,
  };
  b.pass = runB.status === 0 && b.correct_invoked && b.analysed_flagged.length === 3 && b.analysed_flagged.every((d) => d.status === "needs_review" || d.status === "superseded") && b.untouched_ok && b.validate_ok;

  // Phase C
  const procCountBefore = [...nodesB.values()].filter((n) => n.type === "procedure").length;
  cpSync(join(TOY_EXTRA, "P04.md"), join(store, "corpus", "P04.md"));
  const sidC = randomUUID();
  const runC = runAgent(store, P04_PROMPT, sidC, args);
  const sessionC = runC.sessionId || sidC;
  console.error(`[m2] C: ${args.harness} exited ${runC.status} after ${runC.seconds}s${runC.stderr.trim() ? `; ${runC.stderr.trim().slice(0, 200)}` : ""}`);
  const cellsC = Object.entries(P04_EXPECTED).map(([cell, exp]) => checkCell(store, cell, sessionIdFor(args.harness, sessionC), exp));
  const epsC = episodesOf(store, turnPrefix(args.harness, sessionC));
  const nodesC = loadStore(store).nodes;
  const c: PhaseC = {
    seconds: runC.seconds,
    cells: cellsC,
    chains: cellsC.filter(chainComplete).length,
    values_ok: cellsC.filter((x) => x.value_ok).length,
    reused_procedure: epsC.some((e) => e.type === "episode" && e.uses.includes("proc_tablecount01")),
    procedure_count_before: procCountBefore,
    procedure_count_after: [...nodesC.values()].filter((n) => n.type === "procedure").length,
    non_agent_share: nonAgentShare(store, turnPrefix(args.harness, sessionC)),
    validate_ok: cli(store, ["validate"]).status === 0,
    pass: false,
  };
  c.pass = runC.status === 0 && c.chains === 3 && c.values_ok >= 2 && c.reused_procedure && c.procedure_count_after === c.procedure_count_before && c.validate_ok;

  const kpiJson = cli(store, ["kpi"]).json;
  const report = { store, harness: args.harness, model: args.model, sessions: { A: sessionIdFor(args.harness, sessionA), B: sessionIdFor(args.harness, sessionB), C: sessionIdFor(args.harness, sessionC) }, A: a, B: b, C: c, hooks: hookEvents(store).events, kpi: kpiJson, pass: a.pass && b.pass && c.pass };
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nM2 live test (${args.harness}): ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`  A: ${a.pass ? "PASS" : "FAIL"} ${a.seconds}s validate=${a.validate_ok} chains=${a.chains}/6 procedure=${a.procedure_state} shown_uses=${a.procedure_shown_uses} nonAgent=${a.non_agent_share}`);
  console.log(`  B: ${b.pass ? "PASS" : "FAIL"} ${b.seconds}s correct=${b.correct_invoked} flagged=${b.analysed_flagged.map((d) => `${d.id}:${d.status}`).join(",")} untouched=${b.untouched_ok} newCriterion=${b.new_criterion}`);
  console.log(`  C: ${c.pass ? "PASS" : "FAIL"} ${c.seconds}s chains=${c.chains}/3 values=${c.values_ok}/3 reused=${c.reused_procedure} procedures=${c.procedure_count_before}->${c.procedure_count_after} nonAgent=${c.non_agent_share}`);
  cleanup(store, args.keep);
  process.exitCode = report.pass ? 0 : 1;
}

main();
