import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runHeadless, type RunnerHarness } from "../agent/runner.js";
import { retire } from "../lifecycle/procedures.js";
import type { LoadedStore } from "../store/files.js";
import { CliError, truncate } from "../util.js";

export interface RecheckCase {
  file: string;
  expected: unknown;
  got: unknown;
  pass: boolean;
}

export interface RecheckResult {
  procedure: string;
  model: string | null;
  cases: RecheckCase[];
  all_pass: boolean;
  retired: boolean;
}

const VALUE_SCHEMA = { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: ["string", "number", "boolean", "null"] } } } as Record<string, unknown>;

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Sublation check: can the model alone, without the procedure's code, reproduce every regression case?
 * If so the procedure is retired; its past outputs stand, the agent call simply moves up one level.
 */
export function recheckProcedure(store: LoadedStore, procId: string, opts: { harness: RunnerHarness; model?: string | null; retireOnPass?: boolean; budgetUsd?: number }): RecheckResult {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  if (!proc.regression_cases.length) throw new CliError(`${procId} has no regression cases; add some under procedures/.../cases before rechecking`, 2);
  const cases: RecheckCase[] = [];
  for (const rel of proc.regression_cases) {
    const p = join(store.root, rel);
    if (!existsSync(p)) throw new CliError(`regression case ${rel} not found`, 2);
    const c = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const expected = c["expected"] ?? c["expected_total"];
    const input = c["input"];
    const inputs = Array.isArray(input) ? input : [input];
    const materialised = inputs.map((i) => {
      if (typeof i === "string" && existsSync(join(store.root, i))) return `--- ${i} ---\n${truncate(readFileSync(join(store.root, i), "utf8"), 6000)}`;
      return JSON.stringify(i);
    });
    const prompt = [
      `Without running any code or tool, do what this procedure does by reading the input yourself.`,
      `Procedure: ${proc.title}.`,
      store.bodies.get(procId) ? `Notes: ${truncate(store.bodies.get(procId) ?? "", 800)}` : "",
      `Input:\n${materialised.join("\n")}`,
      'Reply with JSON only: {"value": <the result>}.',
    ]
      .filter(Boolean)
      .join("\n\n");
    const r = runHeadless(store.root, prompt, { harness: opts.harness, schema: VALUE_SCHEMA, model: opts.model ?? null, budgetUsd: opts.budgetUsd ?? 2 });
    const got = (r.json as { value?: unknown } | null)?.value;
    cases.push({ file: rel, expected, got, pass: got !== undefined && sameValue(got, expected) });
  }
  const allPass = cases.every((c) => c.pass);
  let retired = false;
  if (allPass && opts.retireOnPass && proc.state !== "retired") {
    retire(store, procId, `sublation: ${opts.model ?? opts.harness} reproduces all ${cases.length} regression case(s) without the procedure`, null);
    retired = true;
  }
  return { procedure: procId, model: opts.model ?? null, cases, all_pass: allPass, retired };
}
