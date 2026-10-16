/**
 * M1 live acceptance test: a real agent session annotates P02 and P03 in a fresh copy of the toy store.
 *
 *   node dist/src/e2e/m1.js [--harness claude|codex] [--model M] [--runs N] [--budget USD] [--smoke] [--keep] [--settings-flag]
 *
 * --smoke runs a trivial prompt and reports which hooks fired. Exit 0 only when every hard assertion passes in every run.
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionIdFor } from "../schema/ids.js";
import { loadStore } from "../store/files.js";
import { sha256 } from "../util.js";
import { TASK_PROMPT, chainComplete, checkCell, classify, cleanup, cli, hookEvents, parseCommonArgs, prepareStore, runAgent, toolUses, transcriptFor, type AgentRun, type CellReport, type CommonArgs } from "./common.js";

export const EXPECTED: Record<string, number | RegExp> = {
  "P02/n_randomized_total": 84,
  "P02/n_analyzed_total": 80,
  "P02/primary_outcome": /6[- ]?minute walk/i,
  "P03/n_randomized_total": 150,
  "P03/n_analyzed_total": 148,
  "P03/primary_outcome": /pain intensity/i,
};
/** P03 reports a prose/table disagreement on purpose; the table-first value is expected but not required. */
const SOFT_VALUES = new Set(["P03/n_analyzed_total"]);

interface RunReport {
  run: number;
  store: string;
  session: string;
  harness: string;
  agent_exit: number;
  seconds: number;
  cost_usd: unknown;
  turns: unknown;
  validate_ok: boolean;
  cells: (CellReport & { soft: boolean })[];
  index_idempotent: boolean;
  affected_exact: boolean;
  affected_detail: { expected: string[]; actual: string[] };
  hooks: ReturnType<typeof hookEvents>;
  hooks_ok: boolean;
  first_store_access: string | null;
  first_access_via_cli: boolean;
  knowledge_reads: number;
  knowledge_writes: number;
  transcript: string | null;
  hard_pass: boolean;
  soft_notes: string[];
}

export function evaluateRun(store: string, sessionId: string, agent: AgentRun, run: number, args: CommonArgs): RunReport {
  const sessionNode = sessionIdFor(args.harness, sessionId);
  const validate = cli(store, ["validate"]);
  const cells = Object.entries(EXPECTED).map(([cell, expected]) => ({ ...checkCell(store, cell, sessionNode, expected), soft: SOFT_VALUES.has(cell) }));

  const d1 = sha256(cli(store, ["index", "--dump"], false).stdout);
  rmSync(join(store, ".autosoft", "index.sqlite"), { force: true });
  const d2 = sha256(cli(store, ["index", "--dump"], false).stdout);

  const hooks = hookEvents(store);
  const transcript = transcriptFor(store, args.harness, sessionId);
  let firstAccess: string | null = null;
  let reads = 0;
  let writes = 0;
  if (transcript) {
    for (const t of toolUses(transcript)) {
      const c = classify(t);
      if (c === "other") continue;
      if (!firstAccess) firstAccess = `${c}: ${t.name} ${JSON.stringify(t.input).slice(0, 160)}`;
      if (c === "knowledge_read") reads++;
      if (c === "knowledge_write") writes++;
    }
  }

  // Criterion change: every n_analyzed_total annotation must be affected, and nothing else among annotations.
  const loaded = loadStore(store);
  const expectedAffected = [...loaded.nodes.values()]
    .filter((n) => n.type === "decision" && n.kind === "annotation" && n.target?.field === "n_analyzed_total" && n.status !== "superseded" && n.status !== "retired")
    .map((n) => n.id)
    .sort();
  cli(store, ["set", "dec_crit0analyz1", "--json-in", JSON.stringify({ claim: "n_analyzed_total counts participants randomised (changed for the acceptance test)." })]);
  const aff = (cli(store, ["affected", "dec_crit0analyz1"]).json as { id: string; type: string }[] | null) ?? [];
  const annotationIds = new Set([...loaded.nodes.values()].filter((n) => n.type === "decision" && n.kind === "annotation").map((n) => n.id));
  const actualAffected = aff.map((r) => r.id).filter((id) => annotationIds.has(id)).sort();
  const affectedExact = JSON.stringify(actualAffected) === JSON.stringify(expectedAffected) && expectedAffected.length === 3;

  const required = args.harness === "codex" ? ["SessionStart", "UserPromptSubmit", "Stop"] : ["SessionStart", "UserPromptSubmit", "Stop"];
  const hooksOk = required.every((e) => (hooks.events[e] ?? 0) >= 1) && hooks.errors.length === 0;
  const hardCells = cells.every((c) => chainComplete(c) && (c.soft || c.value_ok));
  const firstViaCli = firstAccess?.startsWith("cli:") ?? false;
  const softNotes: string[] = [];
  for (const c of cells) if (c.soft && !c.value_ok) softNotes.push(`${c.cell}: value ${JSON.stringify(c.value)} (hard case, expected ${String(EXPECTED[c.cell])})`);
  if (reads) softNotes.push(`${reads} direct read(s) of knowledge/ despite the nudge`);
  if (hooks.denies) softNotes.push(`${hooks.denies} direct write(s) to knowledge/ were denied and redirected`);
  if (!transcript) softNotes.push("transcript not found: first-access check could not run");

  return {
    run,
    store,
    session: sessionNode,
    harness: args.harness,
    agent_exit: agent.status,
    seconds: agent.seconds,
    cost_usd: agent.result?.["total_cost_usd"],
    turns: agent.result?.["num_turns"],
    validate_ok: validate.status === 0,
    cells,
    index_idempotent: d1 === d2,
    affected_exact: affectedExact,
    affected_detail: { expected: expectedAffected, actual: actualAffected },
    hooks,
    hooks_ok: hooksOk,
    first_store_access: firstAccess,
    first_access_via_cli: firstViaCli,
    knowledge_reads: reads,
    knowledge_writes: writes,
    transcript,
    hard_pass: agent.status === 0 && validate.status === 0 && hardCells && d1 === d2 && affectedExact && hooksOk && firstViaCli,
    soft_notes: softNotes,
  };
}

function main(): void {
  const parsed = parseCommonArgs(process.argv.slice(2));
  const args: CommonArgs = parsed;
  const runsIdx = parsed.rest.indexOf("--runs");
  const runs = runsIdx >= 0 ? Number(parsed.rest[runsIdx + 1]) : 1;
  const smoke = parsed.rest.includes("--smoke");
  if (!existsSync(join(process.cwd(), "dist")) && !existsSync(new URL(".", import.meta.url).pathname)) throw new Error("build first: npm run build");

  if (smoke) {
    const store = prepareStore();
    const sid = randomUUID();
    const r = runAgent(store, "Reply with the single word OK and do nothing else.", sid, { ...args, budget: 1 });
    const hooks = hookEvents(store);
    const sessionExists = existsSync(join(store, "knowledge", "sessions", `${sessionIdFor(args.harness, r.sessionId || sid)}.md`));
    console.log(JSON.stringify({ store, harness: args.harness, agent_exit: r.status, seconds: r.seconds, hooks, session_node_written: sessionExists, stderr: r.stderr.slice(0, 600) }, null, 2));
    cleanup(store, args.keep);
    process.exitCode = hooks.events["SessionStart"] && hooks.events["UserPromptSubmit"] && hooks.events["Stop"] ? 0 : 1;
    return;
  }

  const reports: RunReport[] = [];
  for (let i = 1; i <= runs; i++) {
    const store = prepareStore();
    const sid = randomUUID();
    console.error(`[run ${i}] store ${store} (${args.harness}${args.model ? `, ${args.model}` : ""})`);
    const agent = runAgent(store, TASK_PROMPT, sid, args);
    console.error(`[run ${i}] ${args.harness} exited ${agent.status} after ${agent.seconds}s${agent.stderr.trim() ? `; stderr: ${agent.stderr.trim().slice(0, 300)}` : ""}`);
    const report = evaluateRun(store, agent.sessionId || sid, agent, i, args);
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
    cleanup(store, args.keep);
  }
  const passed = reports.filter((r) => r.hard_pass).length;
  console.log(`\nM1 live test (${args.harness}): ${passed}/${reports.length} runs passed all hard assertions`);
  for (const r of reports) {
    const chains = r.cells.filter(chainComplete).length;
    const values = r.cells.filter((c) => c.value_ok).length;
    console.log(`  run ${r.run}: ${r.hard_pass ? "PASS" : "FAIL"} ${r.seconds}s validate=${r.validate_ok} chains=${chains}/6 values=${values}/6 idempotent=${r.index_idempotent} affected=${r.affected_exact} hooks=${r.hooks_ok} firstViaCli=${r.first_access_via_cli} reads=${r.knowledge_reads} denies=${r.hooks.denies} cost=${String(r.cost_usd)}`);
    for (const n of r.soft_notes) console.log(`      note: ${n}`);
  }
  process.exitCode = passed === reports.length ? 0 : 1;
}

main();
