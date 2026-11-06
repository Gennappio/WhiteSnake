import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname, release } from "node:os";
import { basename, extname, join } from "node:path";
import type { Evidence, Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode } from "../store/ops.js";
import { sha256 } from "../util.js";
import { recomputeProcedureCache, recordTransitionDecision } from "./procedures.js";

export function platformLabel(): string {
  return `${process.platform} ${release()} ${process.arch}`;
}

/** Twelve hex characters of the host name's sha256: two machines with the same platform stay distinguishable, neither is named. */
export function hostLabel(): string {
  return sha256(hostname()).slice(0, 12);
}

function numeric(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/**
 * Compare a regression case's expected value with what a procedure or a model produced, respecting types: an absent
 * value (null or undefined) equals only an absent value, a boolean only a boolean, a number a number or a numeric
 * string (command output is text), objects by structure, and text leniently on case and surrounding space.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  const absentA = a === null || a === undefined;
  const absentB = b === null || b === undefined;
  if (absentA || absentB) return absentA && absentB;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "object" || typeof b === "object") return typeof a === typeof b && JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === "number" || typeof b === "number") {
    const na = numeric(a);
    const nb = numeric(b);
    return na !== null && nb !== null && na === nb;
  }
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
  exit_code?: number | null;
  duration_ms?: number;
}

export interface Execution {
  /** Parsed stdout (JSON, number or text); null when the entrypoint could not run at all. */
  output: unknown;
  exit_code: number | null;
  duration_ms: number;
  error?: string;
}

/** Run a code procedure's entrypoint in the store with positional arguments, the way regression cases and comparisons do. */
export function executeEntrypoint(store: LoadedStore, entrypoint: string, args: string[]): Execution {
  const entry = join(store.root, entrypoint);
  if (!existsSync(entry)) return { output: null, exit_code: null, duration_ms: 0, error: `entrypoint ${entrypoint} missing` };
  const interp = interpreterFor(entrypoint);
  const executable = !interp && (statSync(entry).mode & 0o111) !== 0;
  if (!interp && !executable) return { output: null, exit_code: null, duration_ms: 0, error: `no interpreter for ${entrypoint}` };
  const cmd = interp ? interp[0]! : entry;
  const argv = interp ? [...interp.slice(1), entry, ...args] : args;
  const started = Date.now();
  const r = spawnSync(cmd, argv, { cwd: store.root, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const duration = Date.now() - started;
  if (r.error || r.status !== 0) {
    return { output: parseOutput(r.stdout ?? ""), exit_code: r.status, duration_ms: duration, error: r.error?.message ?? `exit ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}` };
  }
  return { output: parseOutput(r.stdout), exit_code: 0, duration_ms: duration };
}

export interface RegressionCase {
  file: string;
  args: string[];
  expected: unknown;
  /** Set when the case file uses `expected_total`: the procedure's output is an object and its `total` is compared. */
  key: "total" | null;
  error?: string;
}

/** Read a regression case file: positional inputs and the expected value, in either of the two accepted shapes. */
export function readRegressionCase(store: LoadedStore, rel: string): RegressionCase {
  const casePath = join(store.root, rel);
  if (!existsSync(casePath)) return { file: rel, args: [], expected: null, key: null, error: "case file missing" };
  const c = JSON.parse(readFileSync(casePath, "utf8")) as Record<string, unknown>;
  const input = c["input"];
  const args = (Array.isArray(input) ? input : input === undefined ? [] : [input]).map(String);
  if (c["expected_total"] !== undefined) return { file: rel, args, expected: c["expected_total"], key: "total" };
  return { file: rel, args, expected: c["expected"], key: null };
}

/** The part of an output a case compares: the whole output, or its `total` for `expected_total` cases. */
export function projectOutput(output: unknown, key: "total" | null): unknown {
  if (key && output && typeof output === "object" && key in (output as Record<string, unknown>)) return (output as Record<string, unknown>)[key];
  return output;
}

/** Run a code procedure's regression cases by executing its entrypoint with each case's inputs. */
export function runRegressionCases(store: LoadedStore, proc: Procedure): CaseResult[] {
  const results: CaseResult[] = [];
  for (const rel of proc.regression_cases) {
    const c = readRegressionCase(store, rel);
    if (c.error) {
      results.push({ file: rel, ok: false, expected: c.expected, got: null, error: c.error });
      continue;
    }
    const run = executeEntrypoint(store, proc.entrypoint, c.args);
    if (run.error) {
      results.push({ file: rel, ok: false, expected: c.expected, got: run.output, error: run.error, exit_code: run.exit_code, duration_ms: run.duration_ms });
      continue;
    }
    const got = projectOutput(run.output, c.key);
    results.push({ file: rel, ok: sameValue(got, c.expected), expected: c.expected, got, exit_code: run.exit_code, duration_ms: run.duration_ms });
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
      const failing = results.filter((r) => !r.ok);
      const reason = `regression failed on ${platformLabel()}: ${failing.map((r) => `${r.file} expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.got)}${r.error ? ` (${r.error})` : ""}`).join("; ")}`.slice(0, 500);
      // The suspension is an explicit transition: a choice decision whose data is what actually ran here.
      const evidence = failing.map((r) => recordCaseExecution(store, p, r).id);
      recordTransitionDecision(store, p.id, "suspended", reason, null, { evidence, actor: "cli:check", title: `Suspension: ${p.id} fails its regression cases on this platform` });
      recomputeProcedureCache(store, p.id);
      out.suspended.push({ id: p.id, reason });
    }
  }
  return out;
}

/** Record a regression case's run as execution evidence: the command, how it ended, and the hashes of what it read. */
export function recordCaseExecution(store: LoadedStore, proc: Procedure, r: CaseResult): Evidence {
  const c = readRegressionCase(store, r.file);
  const interp = (interpreterFor(proc.entrypoint) ?? []).map((t) => (t === process.execPath ? "node" : basename(t)));
  const command = [...interp, proc.entrypoint, ...c.args].join(" ");
  const inputHashes: Record<string, string> = {};
  for (const rel of [proc.entrypoint, ...c.args]) {
    const abs = join(store.root, rel);
    if (existsSync(abs) && statSync(abs).isFile()) inputHashes[rel] = sha256(readFileSync(abs));
  }
  const body = JSON.stringify({ expected: r.expected, got: r.got, error: r.error ?? null }, null, 2);
  return createNode(
    store.root,
    "evidence",
    {
      title: `Regression check of ${proc.id} on ${r.file}`,
      kind: "execution",
      locator: { path: r.file },
      execution: { command, cwd: ".", exit_code: r.exit_code ?? -1, duration_ms: r.duration_ms ?? null, platform: platformLabel(), host: hostLabel(), input_hashes: inputHashes, truncated: false },
      produced_by: null,
    },
    body,
    { store, causedBy: null, actor: "cli:check" },
  ) as Evidence;
}
