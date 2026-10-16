import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode } from "../store/ops.js";
import { sha256, truncate } from "../util.js";
import { platformLabel } from "./regression.js";

export interface RunOptions {
  episode?: string | null;
  title?: string;
  artifact?: string | null;
  path?: string | null;
  inputs?: string[];
  maxBody?: number;
  timeoutMs?: number;
}

export interface RunResult {
  evidence: Evidence;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

/** Tokens of a shell command that name existing files in the store: these are the inputs whose hashes we record. */
export function fileTokens(root: string, command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/\s+/)) {
    const tok = raw.replace(/^["']|["']$/g, "");
    if (!tok || tok.startsWith("-") || tok.includes("://")) continue;
    const abs = join(root, tok);
    try {
      if (!tok.startsWith("/") && existsSync(abs) && statSync(abs).isFile()) out.push(tok);
    } catch {
      // not a path
    }
  }
  return [...new Set(out)];
}

/**
 * Run a shell command in the store and record it as execution evidence in one step: command, exit code, duration,
 * platform, hashes of the input files it names, and its output as the body. Recording becomes cheaper than not recording.
 */
export function runAndRecord(store: LoadedStore, command: string, opts: RunOptions = {}): RunResult {
  const started = Date.now();
  const r = spawnSync("sh", ["-c", command], { cwd: store.root, encoding: "utf8", timeout: opts.timeoutMs ?? 10 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 });
  const duration = Date.now() - started;
  const exit = r.status ?? (r.error ? 1 : 0);
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const inputs = [...new Set([...(opts.inputs ?? []), ...fileTokens(store.root, command)])].sort();
  const hashes: Record<string, string> = {};
  for (const f of inputs) {
    const abs = join(store.root, f);
    if (existsSync(abs)) hashes[f] = sha256(readFileSync(abs));
  }
  const maxBody = opts.maxBody ?? 20_000;
  let body = stdout.trim() || (stderr.trim() ? `[stderr]\n${stderr.trim()}` : "");
  let truncated = false;
  if (body.length > maxBody) {
    body = `${body.slice(0, maxBody)}\n[truncated: ${body.length - maxBody} more characters]`;
    truncated = true;
  }
  const path = opts.path ?? (opts.artifact ? null : (inputs[0] ?? command.split(/\s+/)[0] ?? "."));
  const evidence = createNode(
    store.root,
    "evidence",
    {
      title: opts.title ?? `Execution: ${truncate(command, 80)}`,
      kind: "execution",
      locator: { artifact: opts.artifact ?? null, path, section: command },
      execution: { command, cwd: ".", exit_code: exit, duration_ms: duration, platform: platformLabel(), input_hashes: hashes, truncated },
      produced_by: opts.episode ?? null,
    },
    body,
    { store },
  ) as Evidence;
  return { evidence, exit_code: exit, stdout, stderr, duration_ms: duration };
}
