/**
 * M1 live acceptance test: a real Claude Code session annotates P02 and P03 in a fresh copy of the toy store.
 *
 *   node dist/src/e2e/m1.js [--runs N] [--budget USD] [--smoke] [--keep] [--settings-flag]
 *
 * --smoke runs a trivial prompt and reports which hooks fired (use it first on a new machine).
 * Exit code 0 only when every hard assertion passes in every run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeLogPath } from "../ingest/claude.js";
import { sessionIdFor } from "../schema/ids.js";
import { loadStore } from "../store/files.js";
import { sha256 } from "../util.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(here, "..", "..", "..");
const CLI = join(TOOL_ROOT, "dist", "src", "cli.js");
const BIN = join(TOOL_ROOT, "bin");
const TOY = join(TOOL_ROOT, "examples", "toy-store");

interface Args {
  runs: number;
  budget: number;
  smoke: boolean;
  keep: boolean;
  settingsFlag: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt: number) => {
    const i = a.indexOf(flag);
    return i >= 0 ? Number(a[i + 1]) : dflt;
  };
  return { runs: get("--runs", 1), budget: get("--budget", 10), smoke: a.includes("--smoke"), keep: a.includes("--keep"), settingsFlag: a.includes("--settings-flag") };
}

function cli(store: string, args: string[], json = true): { status: number; stdout: string; json: unknown } {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--store", store, ...(json ? ["--json"] : []), ...args], { encoding: "utf8" });
  let parsed: unknown = null;
  if (json) {
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = null;
    }
  }
  return { status: r.status ?? -1, stdout: r.stdout, json: parsed };
}

function prepareStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "autosoft-e2e-"));
  cpSync(TOY, dir, { recursive: true });
  rmSync(join(dir, ".autosoft"), { recursive: true, force: true });
  const inst = cli(dir, ["hooks", "install"]);
  if (inst.status !== 0) throw new Error(`hooks install failed: ${inst.stdout}`);
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "store: toy fixture"]);
  return dir;
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${BIN}${delimiter}${process.env["PATH"] ?? ""}` };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

function runClaude(store: string, prompt: string, sessionId: string, args: Args, budget: number): { status: number; stdout: string; stderr: string; result: Record<string, unknown> | null } {
  const cmd = ["-p", prompt, "--session-id", sessionId, "--output-format", "json", "--dangerously-skip-permissions", "--max-budget-usd", String(budget)];
  if (args.settingsFlag) cmd.push("--settings", join(store, ".claude", "settings.json"));
  const r = spawnSync("claude", cmd, { cwd: store, encoding: "utf8", env: claudeEnv(), timeout: 25 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 });
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    result = null;
  }
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, result };
}

function hookEvents(store: string): { events: Record<string, number>; errors: string[]; denies: number; nudges: number } {
  const p = join(store, ".autosoft", "hooks.log");
  const events: Record<string, number> = {};
  const errors: string[] = [];
  let denies = 0;
  let nudges = 0;
  if (!existsSync(p)) return { events, errors, denies, nudges };
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { event?: string; error?: string; decision?: string };
    if (e.event) events[e.event] = (events[e.event] ?? 0) + 1;
    if (e.error) errors.push(`${e.event}: ${e.error}`);
    if (e.decision === "deny") denies++;
    if (e.decision === "allow+nudge") nudges++;
  }
  return { events, errors, denies, nudges };
}

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

function toolUses(transcript: string): ToolUse[] {
  const out: ToolUse[] = [];
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type !== "assistant" || rec.isSidechain || !Array.isArray(rec.message?.content)) continue;
    for (const block of rec.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (block.type === "tool_use" && block.name) out.push({ name: block.name, input: block.input ?? {} });
    }
  }
  return out;
}

function classify(t: ToolUse): "cli" | "knowledge_read" | "knowledge_write" | "other" {
  const paths = ["file_path", "path", "pattern", "notebook_path"].map((k) => t.input[k]).filter((v): v is string => typeof v === "string");
  const inKnowledge = paths.some((p) => /(^|\/)knowledge\//.test(p));
  if (t.name === "Bash") {
    const cmd = String(t.input["command"] ?? "");
    if (/(^|[\s;&|(])autosoft(\s|$)|cli\.js/.test(cmd)) return "cli";
    if (/knowledge\//.test(cmd) && /\b(cat|sed|tee|echo|cp|mv|rm|>)\b/.test(cmd)) return /\b(cat|sed -n|head|tail|grep|ls)\b/.test(cmd) && !/>/.test(cmd) ? "knowledge_read" : "knowledge_write";
    return "other";
  }
  if (inKnowledge && ["Read", "Grep", "Glob", "LS"].includes(t.name)) return "knowledge_read";
  if (inKnowledge && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(t.name)) return "knowledge_write";
  return "other";
}

const EXPECTED: Record<string, number | RegExp> = {
  "P02/n_randomized_total": 84,
  "P02/n_analyzed_total": 80,
  "P02/primary_outcome": /6[- ]?minute walk/i,
  "P03/n_randomized_total": 150,
  "P03/n_analyzed_total": 148,
  "P03/primary_outcome": /pain intensity/i,
};
const SOFT_VALUES = new Set(["P03/n_analyzed_total"]);

interface WhyNodeJson {
  id: string;
  type: string;
  kind?: string;
  value?: unknown;
  locator?: { artifact?: string | null; path?: string | null };
  children: { rel: string; node: WhyNodeJson }[];
}

interface CellReport {
  cell: string;
  decision: string | null;
  data: boolean;
  locator: boolean;
  warrant: boolean;
  caused_by_session: boolean;
  value: unknown;
  value_ok: boolean;
  soft: boolean;
}

function checkCell(store: string, cell: string, sessionNode: string): CellReport {
  const r = cli(store, ["why", cell]);
  const tree = r.status === 0 ? (r.json as WhyNodeJson) : null;
  const report: CellReport = { cell, decision: tree?.id ?? null, data: false, locator: false, warrant: false, caused_by_session: false, value: tree?.value, value_ok: false, soft: SOFT_VALUES.has(cell) };
  if (!tree) return report;
  const data = tree.children.filter((c) => c.rel === "data").map((c) => c.node);
  report.data = data.length > 0;
  report.locator = data.some((ev) => ev.children.some((c) => c.rel === "locator" && c.node.type === "artifact") || (typeof ev.locator?.path === "string" && existsSync(join(store, ev.locator.path))));
  report.warrant = tree.children.some((c) => c.rel === "warrant" && c.node.kind === "criterion");
  report.caused_by_session = tree.children.some((c) => c.rel === "caused_by" && c.node.type === "turn" && c.node.id.startsWith(sessionNode.replace(/^ses_/, "turn_") + "_"));
  const expected = EXPECTED[cell];
  if (expected instanceof RegExp) report.value_ok = typeof tree.value === "string" && expected.test(tree.value);
  else report.value_ok = Number(tree.value) === expected;
  return report;
}

interface RunReport {
  run: number;
  store: string;
  session: string;
  claude_exit: number;
  claude_cost_usd: unknown;
  claude_turns: unknown;
  validate_ok: boolean;
  cells: CellReport[];
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

function evaluateRun(store: string, sessionId: string, claude: ReturnType<typeof runClaude>, run: number): RunReport {
  const sessionNode = sessionIdFor("claude", sessionId);
  const validate = cli(store, ["validate"]);
  const cells = Object.keys(EXPECTED).map((c) => checkCell(store, c, sessionNode));

  const d1 = sha256(cli(store, ["index", "--dump"], false).stdout);
  rmSync(join(store, ".autosoft", "index.sqlite"), { force: true });
  const d2 = sha256(cli(store, ["index", "--dump"], false).stdout);

  // Transcript and hooks before mutating the criterion.
  const hooks = hookEvents(store);
  const loaded = loadStore(store);
  const sessionRec = loaded.nodes.get(sessionNode);
  let transcript: string | null = sessionRec && sessionRec.type === "session" ? sessionRec.log_path : null;
  if (!transcript || !existsSync(transcript)) transcript = claudeLogPath(sessionId, store);
  if (!existsSync(transcript)) transcript = null;
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

  // Criterion change: every n_analyzed_total annotation (P01 fixture + the agent's P02, P03) must be affected, nothing else among annotations.
  const expectedAffected = [...loaded.nodes.values()]
    .filter((n) => n.type === "decision" && n.kind === "annotation" && n.target?.field === "n_analyzed_total" && n.status !== "superseded" && n.status !== "retired")
    .map((n) => n.id)
    .sort();
  cli(store, ["set", "dec_crit0analyz1", "--json-in", JSON.stringify({ claim: "n_analyzed_total counts participants randomised (changed for the acceptance test)." })]);
  const aff = (cli(store, ["affected", "dec_crit0analyz1"]).json as { id: string; type: string }[] | null) ?? [];
  const annotationIds = new Set([...loaded.nodes.values()].filter((n) => n.type === "decision" && n.kind === "annotation").map((n) => n.id));
  const actualAffected = aff.map((r) => r.id).filter((id) => annotationIds.has(id)).sort();
  const affectedExact = JSON.stringify(actualAffected) === JSON.stringify(expectedAffected) && expectedAffected.length === 3;

  const hooksOk = (hooks.events["SessionStart"] ?? 0) >= 1 && (hooks.events["UserPromptSubmit"] ?? 0) >= 1 && (hooks.events["Stop"] ?? 0) >= 1 && hooks.errors.length === 0;
  const hardCells = cells.every((c) => c.decision && c.data && c.locator && c.warrant && c.caused_by_session && (c.soft || c.value_ok));
  const firstViaCli = firstAccess?.startsWith("cli:") ?? false;
  const softNotes: string[] = [];
  for (const c of cells) if (c.soft && !c.value_ok) softNotes.push(`${c.cell}: value ${JSON.stringify(c.value)} (hard case, expected ${String(EXPECTED[c.cell])})`);
  if (reads) softNotes.push(`${reads} direct read(s) of knowledge/ despite the nudge`);
  if (hooks.denies) softNotes.push(`${hooks.denies} direct write(s) to knowledge/ were denied and redirected`);

  return {
    run,
    store,
    session: sessionNode,
    claude_exit: claude.status,
    claude_cost_usd: claude.result?.["total_cost_usd"],
    claude_turns: claude.result?.["num_turns"],
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
    hard_pass: claude.status === 0 && validate.status === 0 && hardCells && d1 === d2 && affectedExact && hooksOk && firstViaCli,
    soft_notes: softNotes,
  };
}

const TASK_PROMPT = [
  "Annotate papers P02 and P03 (corpus/P02.md, corpus/P03.md) for the three output fields defined in autosoft.yaml:",
  "n_randomized_total, n_analyzed_total, primary_outcome.",
  "Follow the autosoft skill in .claude/skills/autosoft/SKILL.md: consult precedents and criteria first, open an episode per paper,",
  "capture verbatim evidence with its artifact locator, record each value as a decision citing its evidence (data) and the criterion (warrant),",
  "close the episodes, then run `autosoft validate` and finish by listing the decision ids you created.",
].join(" ");

function main(): void {
  const args = parseArgs();
  const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
  if (which.status !== 0) throw new Error("claude CLI not found on PATH");
  if (!existsSync(CLI)) throw new Error("build first: npm run build");

  if (args.smoke) {
    const store = prepareStore();
    const sid = randomUUID();
    const r = runClaude(store, "Reply with the single word OK and do nothing else.", sid, args, 1);
    const hooks = hookEvents(store);
    const sessionExists = existsSync(join(store, "knowledge", "sessions", `${sessionIdFor("claude", sid)}.md`));
    console.log(JSON.stringify({ store, claude_exit: r.status, result_type: r.result?.["type"], hooks, session_node_written: sessionExists, stderr: r.stderr.slice(0, 500) }, null, 2));
    if (!args.keep) rmSync(store, { recursive: true, force: true });
    process.exitCode = hooks.events["SessionStart"] && hooks.events["UserPromptSubmit"] && hooks.events["Stop"] ? 0 : 1;
    return;
  }

  const reports: RunReport[] = [];
  for (let i = 1; i <= args.runs; i++) {
    const store = prepareStore();
    const sid = randomUUID();
    console.error(`[run ${i}] store ${store} session ${sid}`);
    const started = Date.now();
    const claude = runClaude(store, TASK_PROMPT, sid, args, args.budget);
    console.error(`[run ${i}] claude exited ${claude.status} after ${Math.round((Date.now() - started) / 1000)}s${claude.stderr ? `; stderr: ${claude.stderr.slice(0, 300)}` : ""}`);
    const report = evaluateRun(store, sid, claude, i);
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
    if (!args.keep) rmSync(store, { recursive: true, force: true });
  }
  const passed = reports.filter((r) => r.hard_pass).length;
  console.log(`\nM1 live test: ${passed}/${reports.length} runs passed all hard assertions`);
  for (const r of reports) {
    const cellsOk = r.cells.filter((c) => c.decision && c.data && c.locator && c.warrant && c.caused_by_session).length;
    const valuesOk = r.cells.filter((c) => c.value_ok).length;
    console.log(`  run ${r.run}: ${r.hard_pass ? "PASS" : "FAIL"} validate=${r.validate_ok} chains=${cellsOk}/6 values=${valuesOk}/6 idempotent=${r.index_idempotent} affected=${r.affected_exact} hooks=${r.hooks_ok} firstViaCli=${r.first_access_via_cli} reads=${r.knowledge_reads} denies=${r.hooks.denies} cost=${String(r.claude_cost_usd)}`);
    for (const n of r.soft_notes) console.log(`      note: ${n}`);
  }
  process.exitCode = passed === reports.length ? 0 : 1;
}

main();
