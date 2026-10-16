/** Shared helpers for the live acceptance tests: store preparation, harness runners, transcript and hook inspection. */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeLogPath } from "../ingest/claude.js";
import { sessionIdFor } from "../schema/ids.js";
import { loadStore } from "../store/files.js";

const here = dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = resolve(here, "..", "..", "..");
export const CLI = join(TOOL_ROOT, "dist", "src", "cli.js");
export const BIN = join(TOOL_ROOT, "bin");
export const TOY = join(TOOL_ROOT, "examples", "toy-store");
export const TOY_EXTRA = join(TOOL_ROOT, "examples", "toy-corpus-extra");

export type Harness = "claude" | "codex";

export interface CommonArgs {
  harness: Harness;
  model: string | null;
  budget: number;
  keep: boolean;
  settingsFlag: boolean;
}

export function parseCommonArgs(a: string[]): CommonArgs & { rest: string[] } {
  const get = (flag: string): string | null => {
    const i = a.indexOf(flag);
    return i >= 0 ? (a[i + 1] ?? null) : null;
  };
  return {
    harness: get("--harness") === "codex" ? "codex" : "claude",
    model: get("--model"),
    budget: Number(get("--budget") ?? 10),
    keep: a.includes("--keep"),
    settingsFlag: a.includes("--settings-flag"),
    rest: a,
  };
}

export function cli(store: string, args: string[], json = true): { status: number; stdout: string; json: unknown } {
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

/** Fresh copy of the toy store with skill, hooks and a git repository, in a temp directory. */
export function prepareStore(prefix = "whitesnake-e2e-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(TOY, dir, { recursive: true });
  rmSync(join(dir, ".whitesnake"), { recursive: true, force: true });
  const inst = cli(dir, ["hooks", "install"]);
  if (inst.status !== 0) throw new Error(`hooks install failed: ${inst.stdout}`);
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "store: toy fixture"]);
  return dir;
}

/** Environment for a nested harness: our launcher on PATH, the parent Claude Code session variables removed. */
export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${BIN}${delimiter}${process.env["PATH"] ?? ""}` };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

export interface AgentRun {
  status: number;
  stdout: string;
  stderr: string;
  result: Record<string, unknown> | null;
  /** Native session id: the --session-id we passed to Claude, or the thread_id Codex reported. */
  sessionId: string;
  seconds: number;
}

export function runAgent(store: string, prompt: string, sessionId: string, args: CommonArgs): AgentRun {
  const started = Date.now();
  const run = args.harness === "codex" ? runCodex(store, prompt, args) : runClaude(store, prompt, sessionId, args);
  return { ...run, seconds: Math.round((Date.now() - started) / 1000) };
}

function runClaude(store: string, prompt: string, sessionId: string, args: CommonArgs): Omit<AgentRun, "seconds"> {
  const cmd = ["-p", prompt, "--session-id", sessionId, "--output-format", "json", "--dangerously-skip-permissions", "--max-budget-usd", String(args.budget)];
  if (args.model) cmd.push("--model", args.model);
  if (args.settingsFlag) cmd.push("--settings", join(store, ".claude", "settings.json"));
  const r = spawnSync("claude", cmd, { cwd: store, encoding: "utf8", env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 25 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 });
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    result = null;
  }
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, result, sessionId };
}

/** Codex headless. A fresh temp store has no persisted hook trust, hence the bypass flag; the sandbox bypass mirrors Claude's. */
function runCodex(store: string, prompt: string, args: CommonArgs): Omit<AgentRun, "seconds"> {
  const lastMsg = join(store, ".whitesnake", `codex-last-message-${Date.now()}.txt`);
  const cmd = ["exec", "-C", store, "--json", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-o", lastMsg];
  if (args.model) cmd.push("-m", args.model);
  cmd.push(prompt);
  const r = spawnSync("codex", cmd, { cwd: store, encoding: "utf8", env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 25 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 });
  let threadId = "";
  const failures: string[] = [];
  for (const line of r.stdout.split("\n")) {
    try {
      const ev = JSON.parse(line) as { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: { type?: string; message?: string } };
      if (ev.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
      if (ev.type === "turn.failed") failures.push(`turn.failed: ${ev.error?.message ?? ""}`.slice(0, 400));
      else if (ev.type === "error") failures.push(`error: ${ev.message ?? ""}`.slice(0, 400));
      else if (ev.type === "item.completed" && ev.item?.type === "error" && ev.item.message && !/dangerously/.test(ev.item.message)) failures.push(`item error: ${ev.item.message}`.slice(0, 400));
    } catch {
      // not an event line
    }
  }
  const final = existsSync(lastMsg) ? readFileSync(lastMsg, "utf8") : "";
  return { status: r.status ?? -1, stdout: r.stdout, stderr: failures.length ? `${r.stderr}\n${failures.join("\n")}` : r.stderr, result: { type: "result", result: final, thread_id: threadId }, sessionId: threadId };
}

export function codexRolloutPath(threadId: string): string | null {
  const base = join(homedir(), ".codex", "sessions");
  if (!existsSync(base) || !threadId) return null;
  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (entry.name.endsWith(`${threadId}.jsonl`)) return p;
    }
    return null;
  };
  return walk(base);
}

/** Transcript of a session: the path the Stop hook recorded on the session node, else the harness default location. */
export function transcriptFor(store: string, harness: Harness, sessionId: string): string | null {
  const node = loadStore(store).nodes.get(sessionIdFor(harness, sessionId));
  let t: string | null = node && node.type === "session" ? node.log_path : null;
  if (!t || !existsSync(t)) t = harness === "codex" ? codexRolloutPath(sessionId) : claudeLogPath(sessionId, store);
  return t && existsSync(t) ? t : null;
}

export interface HookSummary {
  events: Record<string, number>;
  errors: string[];
  denies: number;
  nudges: number;
  commands: string[];
}

export function hookEvents(store: string): HookSummary {
  const p = join(store, ".whitesnake", "hooks.log");
  const out: HookSummary = { events: {}, errors: [], denies: 0, nudges: 0, commands: [] };
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { event?: string; error?: string; decision?: string; command?: string };
    if (e.event) out.events[e.event] = (out.events[e.event] ?? 0) + 1;
    if (e.error) out.errors.push(`${e.event}: ${e.error}`);
    if (e.decision === "deny") out.denies++;
    if (e.decision === "allow+nudge") out.nudges++;
    if (e.command) out.commands.push(e.command);
  }
  return out;
}

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

/** Tool calls in a Claude Code transcript or a Codex rollout, in order. */
export function toolUses(transcript: string): ToolUse[] {
  const out: ToolUse[] = [];
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; isSidechain?: boolean; message?: { content?: unknown }; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type === "assistant" && !rec.isSidechain && Array.isArray(rec.message?.content)) {
      for (const block of rec.message!.content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (block.type === "tool_use" && block.name) out.push({ name: block.name, input: block.input ?? {} });
      }
      continue;
    }
    if (rec.type === "response_item" && rec.payload) {
      const p = rec.payload;
      if (p["type"] === "custom_tool_call" && typeof p["name"] === "string") {
        if (typeof p["input"] === "string") out.push(...expandExecScript(p["name"] as string, p["input"]));
        else out.push({ name: p["name"] as string, input: (p["input"] as Record<string, unknown>) ?? {} });
      }
      else if (p["type"] === "function_call" && typeof p["name"] === "string") {
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = JSON.parse(String(p["arguments"] ?? "{}")) as Record<string, unknown>;
        } catch {
          argsObj = { command: String(p["arguments"] ?? "") };
        }
        out.push({ name: p["name"] as string, input: argsObj });
      } else if (p["type"] === "local_shell_call") {
        const action = p["action"] as { command?: string[] } | undefined;
        out.push({ name: "shell", input: { command: (action?.command ?? []).join(" ") } });
      }
    }
  }
  return out;
}

/**
 * Codex's `exec` tool takes a JavaScript program that may call `tools.exec_command({cmd: "..."})` several times.
 * Each embedded command is reported as its own Bash call, in order; a script without recognisable commands is kept whole.
 */
export function expandExecScript(name: string, script: string): ToolUse[] {
  const out: ToolUse[] = [];
  const re = /\bcmd:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;
  for (const m of script.matchAll(re)) {
    const raw = m[2] ?? "";
    const cmd = raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    out.push({ name: "Bash", input: { command: cmd } });
  }
  return out.length ? out : [{ name, input: { command: script } }];
}

export type Access = "cli" | "knowledge_read" | "knowledge_write" | "other";

export function classify(t: ToolUse): Access {
  const paths = ["file_path", "path", "pattern", "notebook_path"].map((k) => t.input[k]).filter((v): v is string => typeof v === "string");
  const inKnowledge = paths.some((p) => /(^|\/)knowledge\//.test(p));
  if (["Bash", "shell", "exec", "exec_command", "local_shell", "container.exec", "bash"].includes(t.name)) {
    const raw = t.input["command"] ?? t.input["cmd"];
    const cmd = Array.isArray(raw) ? raw.map(String).join(" ") : String(raw ?? "");
    // A Codex exec script may mix several commands: whichever touches the store first decides the class.
    const cliAt = cmd.search(/(^|[\s;&|(])whitesnake(\s|$)|cli\.js/);
    const knowledgeAt = cmd.search(/(^|[\s'"=\/])knowledge(\/|\b)/);
    if (cliAt >= 0 && (knowledgeAt < 0 || cliAt <= knowledgeAt)) return "cli";
    if (knowledgeAt >= 0) return /(^|[^<])>{1,2}\s*\S*knowledge\/|\b(tee|cp|mv|rm|sed\s+-i)\b[^;&|]*knowledge/.test(cmd) ? "knowledge_write" : "knowledge_read";
    return "other";
  }
  if (inKnowledge && ["Read", "Grep", "Glob", "LS"].includes(t.name)) return "knowledge_read";
  if (inKnowledge && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(t.name)) return "knowledge_write";
  if (t.name === "apply_patch" && /\*\*\* (Add|Update|Delete) File: knowledge\//.test(String(t.input["patch"] ?? t.input["input"] ?? ""))) return "knowledge_write";
  return "other";
}

/** Commands the agent ran through the CLI during a session, from the transcript. */
export function cliCommands(transcript: string): string[] {
  return toolUses(transcript)
    .filter((t) => classify(t) === "cli")
    .map((t) => {
      const raw = t.input["command"] ?? t.input["cmd"];
      return Array.isArray(raw) ? raw.map(String).join(" ") : String(raw ?? "");
    });
}

export const TASK_PROMPT = [
  "Annotate papers P02 and P03 (corpus/P02.md, corpus/P03.md) for the three output fields defined in whitesnake.yaml:",
  "n_randomized_total, n_analyzed_total, primary_outcome.",
  "Follow the whitesnake skill in .claude/skills/whitesnake/SKILL.md: consult precedents and criteria first, open an episode per paper,",
  "capture verbatim evidence with its artifact locator, record each value as a decision citing its evidence (data) and the criterion (warrant),",
  "close the episodes, then run `whitesnake validate` and finish by listing the decision ids you created.",
].join(" ");

export interface WhyNodeJson {
  id: string;
  type: string;
  kind?: string;
  status?: string;
  value?: unknown;
  locator?: { artifact?: string | null; path?: string | null };
  children: { rel: string; node: WhyNodeJson }[];
}

export interface CellReport {
  cell: string;
  decision: string | null;
  status: string | null;
  data: boolean;
  locator: boolean;
  warrant: boolean;
  caused_by_session: boolean;
  value: unknown;
  value_ok: boolean;
}

/** Structural check of one cell: decision present, evidence with resolvable locator, criterion as warrant, prompt of the given session. */
export function checkCell(store: string, cell: string, sessionNode: string, expected: number | RegExp | null): CellReport {
  const r = cli(store, ["why", cell]);
  const tree = r.status === 0 ? (r.json as WhyNodeJson) : null;
  const report: CellReport = { cell, decision: tree?.id ?? null, status: tree?.status ?? null, data: false, locator: false, warrant: false, caused_by_session: false, value: tree?.value, value_ok: false };
  if (!tree) return report;
  const data = tree.children.filter((c) => c.rel === "data").map((c) => c.node);
  report.data = data.length > 0;
  report.locator = data.some((ev) => ev.children.some((c) => c.rel === "locator" && c.node.type === "artifact") || (typeof ev.locator?.path === "string" && existsSync(join(store, ev.locator.path))));
  report.warrant = tree.children.some((c) => c.rel === "warrant" && c.node.kind === "criterion");
  report.caused_by_session = tree.children.some((c) => c.rel === "caused_by" && c.node.type === "turn" && c.node.id.startsWith(`${sessionNode.replace(/^ses_/, "turn_")}_`));
  if (expected instanceof RegExp) report.value_ok = typeof tree.value === "string" && expected.test(tree.value);
  else if (expected !== null) report.value_ok = Number(tree.value) === expected;
  else report.value_ok = true;
  return report;
}

export function chainComplete(c: CellReport): boolean {
  return !!c.decision && c.data && c.locator && c.warrant && c.caused_by_session;
}

export function cleanup(store: string, keep: boolean): void {
  if (!keep) rmSync(store, { recursive: true, force: true });
}
