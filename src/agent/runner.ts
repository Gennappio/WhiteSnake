import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, ensureDir, writeText } from "../util.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(here, "..", "..", "..");

export type RunnerHarness = "claude" | "codex" | "stub";

export interface HeadlessOptions {
  harness: RunnerHarness;
  schema?: Record<string, unknown>;
  model?: string | null;
  budgetUsd?: number;
  timeoutMs?: number;
}

export interface HeadlessResult {
  status: number;
  sessionId: string | null;
  text: string;
  json: unknown;
  stdout: string;
  stderr: string;
}

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(TOOL_ROOT, "bin")}${delimiter}${process.env["PATH"] ?? ""}` };
  for (const k of Object.keys(e)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete e[k];
  return e;
}

function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Run a coding agent headless in `cwd` with a prompt and, optionally, a JSON schema for its final answer.
 * The stub harness runs the script named by AUTOSOFT_STUB_SCRIPT with the prompt on stdin: deterministic tests.
 */
export function runHeadless(cwd: string, prompt: string, opts: HeadlessOptions): HeadlessResult {
  const timeout = opts.timeoutMs ?? 25 * 60 * 1000;
  ensureDir(join(cwd, ".autosoft"));
  if (opts.harness === "stub") {
    const script = process.env["AUTOSOFT_STUB_SCRIPT"];
    if (!script || !existsSync(script)) throw new CliError("stub harness needs AUTOSOFT_STUB_SCRIPT pointing to an executable script", 1);
    const r = spawnSync(script, [], { cwd, input: prompt, encoding: "utf8", env: { ...env(), AUTOSOFT_SCHEMA: opts.schema ? JSON.stringify(opts.schema) : "" }, timeout });
    return { status: r.status ?? -1, sessionId: `stub${Date.now().toString(36)}`, text: r.stdout, json: parseJsonLoose(r.stdout), stdout: r.stdout, stderr: r.stderr };
  }
  if (opts.harness === "claude") {
    const cmd = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--max-budget-usd", String(opts.budgetUsd ?? 10)];
    if (opts.schema) cmd.push("--json-schema", JSON.stringify(opts.schema));
    if (opts.model) cmd.push("--model", opts.model);
    const r = spawnSync("claude", cmd, { cwd, encoding: "utf8", env: env(), stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 256 * 1024 * 1024 });
    let result: Record<string, unknown> | null = null;
    try {
      result = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      result = null;
    }
    const structured = result?.["structured_output"];
    const text = typeof result?.["result"] === "string" ? (result["result"] as string) : r.stdout;
    return { status: r.status ?? -1, sessionId: typeof result?.["session_id"] === "string" ? (result["session_id"] as string) : null, text, json: structured ?? parseJsonLoose(text), stdout: r.stdout, stderr: r.stderr };
  }
  // codex
  const stamp = Date.now().toString(36);
  const last = join(cwd, ".autosoft", `codex-last-${stamp}.txt`);
  const cmd = ["exec", "-C", cwd, "--json", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-o", last];
  if (opts.schema) {
    const schemaPath = join(cwd, ".autosoft", `schema-${stamp}.json`);
    writeText(schemaPath, JSON.stringify(opts.schema));
    cmd.push("--output-schema", schemaPath);
  }
  if (opts.model) cmd.push("-m", opts.model);
  cmd.push(prompt);
  const r = spawnSync("codex", cmd, { cwd, encoding: "utf8", env: env(), stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 256 * 1024 * 1024 });
  let threadId: string | null = null;
  const failures: string[] = [];
  for (const line of r.stdout.split("\n")) {
    try {
      const ev = JSON.parse(line) as { type?: string; thread_id?: string; message?: string; error?: { message?: string } };
      if (ev.type === "thread.started" && ev.thread_id) threadId = ev.thread_id;
      if (ev.type === "turn.failed") failures.push(`turn.failed: ${ev.error?.message ?? ""}`.slice(0, 600));
      else if (ev.type === "error") failures.push(`error: ${ev.message ?? ""}`.slice(0, 600));
    } catch {
      // not an event
    }
  }
  const text = existsSync(last) ? readFileSync(last, "utf8") : "";
  return { status: r.status ?? -1, sessionId: threadId, text, json: parseJsonLoose(text), stdout: r.stdout, stderr: failures.length ? `${r.stderr}\n${failures.join("\n")}`.trim() : r.stderr };
}

export function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TOOL_ROOT, "schemas", name), "utf8")) as Record<string, unknown>;
}
