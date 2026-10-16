import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import { extname, join } from "node:path";
import type { Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { transition } from "./procedures.js";

export function platformLabel(): string {
  return `${process.platform} ${release()} ${process.arch}`;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** Parse a command's stdout the way regression cases expect: JSON when it is JSON, a number when numeric, else text. */
export function parseOutput(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return "";
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function interpreterFor(entrypoint: string): string[] | null {
  switch (extname(entrypoint)) {
    case ".py":
      return ["python3"];
    case ".sh":
      return ["sh"];
    case ".js":
    case ".mjs":
    case ".cjs":
      return [process.execPath];
    case ".ts":
      return [process.execPath, "--disable-warning=ExperimentalWarning"];
    default:
      return null;
  }
}

export interface CaseResult {
  file: string;
  ok: boolean;
  expected: unknown;
  got: unknown;
  error?: string;
}

/** Run a code procedure's regression cases by executing its entrypoint with each case's inputs. */
export function runRegressionCases(store: LoadedStore, proc: Procedure): CaseResult[] {
  const results: CaseResult[] = [];
  const entry = join(store.root, proc.entrypoint);
  for (const rel of proc.regression_cases) {
    const casePath = join(store.root, rel);
    if (!existsSync(casePath)) {
      results.push({ file: rel, ok: false, expected: null, got: null, error: "case file missing" });
      continue;
    }
    const c = JSON.parse(readFileSync(casePath, "utf8")) as Record<string, unknown>;
    const expected = c["expected"] ?? c["expected_total"];
    const input = c["input"];
    const args = (Array.isArray(input) ? input : input === undefined ? [] : [input]).map(String);
    if (!existsSync(entry)) {
      results.push({ file: rel, ok: false, expected, got: null, error: `entrypoint ${proc.entrypoint} missing` });
      continue;
    }
    const interp = interpreterFor(proc.entrypoint);
    const executable = !interp && (statSync(entry).mode & 0o111) !== 0;
    if (!interp && !executable) {
      results.push({ file: rel, ok: false, expected, got: null, error: `no interpreter for ${proc.entrypoint}` });
      continue;
    }
    const cmd = interp ? interp[0]! : entry;
    const argv = interp ? [...interp.slice(1), entry, ...args] : args;
    const r = spawnSync(cmd, argv, { cwd: store.root, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      results.push({ file: rel, ok: false, expected, got: parseOutput(r.stdout ?? ""), error: r.error?.message ?? `exit ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}` });
      continue;
    }
    const parsed = parseOutput(r.stdout);
    const got = c["expected_total"] !== undefined && parsed && typeof parsed === "object" && "total" in (parsed as Record<string, unknown>) ? (parsed as Record<string, unknown>)["total"] : parsed;
    results.push({ file: rel, ok: sameValue(got, expected), expected, got });
  }
  return results;
}

export interface ProcedureCheck {
  checked: string[];
  passed: string[];
  failed: { id: string; cases: CaseResult[] }[];
  suspended: { id: string; reason: string }[];
}

/**
 * Re-run the regression cases of every usable code procedure on this machine. Procedures that no longer reproduce
 * their cases are suspended with the platform in the reason: the agent falls back to doing the step itself and may
 * supersede them with an adapted version. Nothing is deleted and past outputs stand.
 */
export function checkProcedures(store: LoadedStore, opts: { suspend: boolean }): ProcedureCheck {
  const out: ProcedureCheck = { checked: [], passed: [], failed: [], suspended: [] };
  const procs = [...store.nodes.values()].filter((n): n is Procedure => n.type === "procedure" && n.resolution === "code" && (n.state === "trusted" || n.state === "provisional") && n.regression_cases.length > 0);
  for (const p of procs) {
    const results = runRegressionCases(store, p);
    out.checked.push(p.id);
    if (results.every((r) => r.ok)) {
      out.passed.push(p.id);
      continue;
    }
    out.failed.push({ id: p.id, cases: results });
    if (opts.suspend) {
      const reason = `regression failed on ${platformLabel()}: ${results.filter((r) => !r.ok).map((r) => `${r.file} expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.got)}${r.error ? ` (${r.error})` : ""}`).join("; ")}`.slice(0, 500);
      transition(store, p.id, "suspended", reason, null);
      out.suspended.push({ id: p.id, reason });
    }
  }
  return out;
}
