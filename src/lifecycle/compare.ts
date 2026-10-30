import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode } from "../store/ops.js";
import { CliError, isRecord, sha256 } from "../util.js";
import { deriveBattery, type Basis, type BatteryCase } from "./battery.js";
import { executeEntrypoint, hostLabel, platformLabel, projectOutput, readRegressionCase, sameValue, type Execution } from "./regression.js";
import { median } from "./scorecard.js";

/**
 * One case of the comparison, judged against the record:
 * same: both right (or both as recorded); fixed: the old was wrong, the new is right; regression: the old was right,
 * the new is not; still_wrong: neither; changed_unverified: the new differs on a corrected case but does not match the
 * corrected value; agree/diverge: no verdict exists for this input; gained: the new answers where the old failed, or
 * passes a case the old cannot be run on; stale: the input changed, so nothing can be replayed.
 */
export type Verdict = "same" | "fixed" | "regression" | "still_wrong" | "changed_unverified" | "agree" | "diverge" | "gained" | "stale";
export const VERDICTS: readonly Verdict[] = ["same", "fixed", "regression", "still_wrong", "changed_unverified", "agree", "diverge", "gained", "stale"];

export interface CompareRow {
  key: string;
  source: "regression" | "execution";
  basis: Basis;
  /** A regression case of the new procedure that the old one does not have. */
  extra: boolean;
  args: string[];
  reference: unknown;
  corrected_value?: unknown;
  old_output: unknown;
  new_output: unknown;
  old_error: string | null;
  new_error: string | null;
  old_pass: boolean | null;
  old_ms: number | null;
  new_ms: number | null;
  verdict: Verdict;
  note: string | null;
}

export interface CompareReport {
  old: string;
  new: string;
  platform: string;
  host: string;
  justification_kind: string | null;
  cases: CompareRow[];
  counts: Record<Verdict, number>;
  /** Whether the old procedure's code is present here and still passes its own regression cases. */
  old_runs_here: boolean | null;
  latency: { new_median_ms: number | null; old_median_ms: number | null; old_recorded_median_ms: number | null; faster: boolean | null };
  /** Reasons the new procedure cannot replace the old one. Empty when it may. */
  blocking: string[];
  /** What the new procedure does better, with the cases that show it. */
  improvement: string[];
  /** Never worse on any recorded case, better on at least one: the rule that licenses a replacement. */
  dominates: boolean;
  /** The execution evidence this report was recorded as. */
  evidence: string | null;
}

const VALUE_KEYS = ["total", "value", "result", "count"];

/** Does an output carry the value the researcher gave? The whole output, or a conventional field of an object output. */
export function outputMatchesValue(output: unknown, value: unknown): boolean {
  if (sameValue(output, value)) return true;
  if (isRecord(output)) return VALUE_KEYS.some((k) => k in output && sameValue(output[k], value));
  return false;
}

function procedureOf(store: LoadedStore, id: string): Procedure {
  const p = store.nodes.get(id);
  if (!p || p.type !== "procedure") throw new CliError(`${id} is not a procedure`, 1);
  return p;
}

/** The entrypoint is present and is the registered code (or no hash was registered). */
function codeOnDisk(store: LoadedStore, proc: Procedure): boolean {
  const abs = join(store.root, proc.entrypoint);
  if (!existsSync(abs)) return false;
  return !proc.code_hash || sha256(readFileSync(abs)) === proc.code_hash;
}

function judge(c: BatteryCase, extra: boolean, nw: Execution, od: Execution | null): CompareRow {
  const base: Omit<CompareRow, "verdict" | "note"> = {
    key: c.key,
    source: c.source,
    basis: c.basis,
    extra,
    args: c.args,
    reference: c.reference,
    ...(c.corrected_value !== undefined ? { corrected_value: c.corrected_value } : {}),
    old_output: od ? od.output : null,
    new_output: nw.output,
    old_error: od?.error ?? null,
    new_error: nw.error ?? null,
    old_pass: null,
    old_ms: od && !od.error ? od.duration_ms : null,
    new_ms: nw.error ? null : nw.duration_ms,
  };
  const newOk = !nw.error;
  switch (c.basis) {
    case "expected": {
      const newPass = newOk && sameValue(projectOutput(nw.output, c.project), c.reference);
      const oldPass = od ? !od.error && sameValue(projectOutput(od.output, c.project), c.reference) : extra ? null : true;
      const row = { ...base, old_pass: oldPass };
      if (newPass && oldPass === true) return { ...row, verdict: "same", note: null };
      if (newPass && oldPass === false) return { ...row, verdict: "fixed", note: extra ? "a case of the new procedure that the old one fails" : "the old procedure no longer passes its own case on this machine" };
      if (newPass) return { ...row, verdict: "gained", note: "a case of the new procedure; the old one cannot be run here to compare" };
      if (oldPass === false) return { ...row, verdict: "still_wrong", note: null };
      return { ...row, verdict: "regression", note: `expected ${JSON.stringify(c.reference)}` };
    }
    case "accepted":
      if (newOk && sameValue(nw.output, c.reference)) return { ...base, verdict: "same", note: null };
      return { ...base, verdict: "regression", note: `the researcher accepted the recorded output${c.decision ? ` (${c.decision})` : ""}` };
    case "corrected":
      if (!newOk) return { ...base, verdict: "changed_unverified", note: "fails where the old procedure answered wrongly" };
      if (sameValue(nw.output, c.reference)) return { ...base, verdict: "still_wrong", note: "same output the researcher corrected" };
      if (c.corrected_value !== undefined && outputMatchesValue(nw.output, c.corrected_value)) return { ...base, verdict: "fixed", note: `matches the corrected value ${JSON.stringify(c.corrected_value)}` };
      return { ...base, verdict: "changed_unverified", note: c.corrected_value !== undefined ? `differs from the recorded output but not the corrected value ${JSON.stringify(c.corrected_value)}` : "differs from the recorded output; the correction gave no value to check against" };
    case "unverified":
      if (newOk && sameValue(nw.output, c.reference)) return { ...base, verdict: "agree", note: null };
      return { ...base, verdict: "diverge", note: "no accepted value for this input: the researcher decides" };
    case "abstained":
      if (!newOk) return { ...base, verdict: "same", note: "both fail on this input" };
      return { ...base, verdict: "gained", note: "answers where the old procedure failed; unverified" };
    default:
      return { ...base, verdict: "stale", note: null };
  }
}

function staleRow(c: BatteryCase, extra: boolean): CompareRow {
  return { key: c.key, source: c.source, basis: c.basis, extra, args: c.args, reference: c.reference, ...(c.corrected_value !== undefined ? { corrected_value: c.corrected_value } : {}), old_output: null, new_output: null, old_error: null, new_error: null, old_pass: null, old_ms: null, new_ms: null, verdict: "stale", note: c.stale };
}

/**
 * Run the new procedure on everything recorded about the old one and judge every case against the record. The old
 * procedure is re-run too when its code is here, for latency and to see whether it still works on this machine.
 * The report is recorded as execution evidence unless `record` is false.
 */
export function compareProcedures(store: LoadedStore, oldId: string, newId: string, opts: { episode?: string | null; record?: boolean } = {}): CompareReport {
  const oldP = procedureOf(store, oldId);
  const newP = procedureOf(store, newId);
  if (oldId === newId) throw new CliError("compare needs two different procedures", 1);
  for (const p of [oldP, newP]) {
    if (p.resolution !== "code") throw new CliError(`${p.id} is a ${p.resolution} procedure; compare replays code procedures only. For a frozen prompt or a skill, record a sampled comparison as evidence yourself.`, 2);
  }
  const started = Date.now();
  const battery = deriveBattery(store, oldP);
  const extra: BatteryCase[] = newP.regression_cases
    .filter((rel) => !oldP.regression_cases.includes(rel))
    .map((rel) => {
      const c = readRegressionCase(store, rel);
      return { key: rel, source: "regression", args: c.args, basis: "expected", reference: c.expected, project: c.key, decision: null, evidence: null, episode: null, recorded_duration_ms: null, recorded_platform: null, code_hash_matches: null, stale: c.error ?? null };
    });
  const oldRunnable = codeOnDisk(store, oldP);
  const rows: CompareRow[] = [];
  for (const [c, isExtra] of [...battery.map((c) => [c, false] as const), ...extra.map((c) => [c, true] as const)]) {
    if (c.stale) {
      rows.push(staleRow(c, isExtra));
      continue;
    }
    const nw = executeEntrypoint(store, newP.entrypoint, c.args);
    const od = oldRunnable ? executeEntrypoint(store, oldP.entrypoint, c.args) : null;
    rows.push(judge(c, isExtra, nw, od));
  }
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, rows.filter((r) => r.verdict === v).length])) as Record<Verdict, number>;
  const ran = rows.filter((r) => r.verdict !== "stale").length;
  const ownCases = rows.filter((r) => r.basis === "expected" && !r.extra);
  const oldRunsHere = !oldRunnable ? false : ownCases.length ? ownCases.every((r) => r.old_pass !== false) : true;
  const newMedian = median(rows.map((r) => r.new_ms).filter((x): x is number => x !== null));
  const oldMedian = median(rows.map((r) => r.old_ms).filter((x): x is number => x !== null));
  const oldRecorded = median(battery.map((c) => c.recorded_duration_ms).filter((x): x is number => x !== null));
  const faster = newMedian !== null && oldMedian !== null ? newMedian < oldMedian : null;
  const kind = newP.justification?.kind ?? null;

  const blocking: string[] = [];
  if (ran === 0) blocking.push(`no case could be replayed: ${oldId} has no regression case or recorded execution to compare on`);
  if (counts.regression) blocking.push(`${counts.regression} regression(s) on accepted results: ${rows.filter((r) => r.verdict === "regression").map((r) => r.key).join(", ")}`);
  if (counts.diverge) blocking.push(`${counts.diverge} divergence(s) without an accepted value: ${rows.filter((r) => r.verdict === "diverge").map((r) => r.key).join(", ")}`);
  if (counts.changed_unverified) blocking.push(`${counts.changed_unverified} changed output(s) on corrected cases that do not match the corrected value: ${rows.filter((r) => r.verdict === "changed_unverified").map((r) => r.key).join(", ")}`);

  const improvement: string[] = [];
  const fixed = rows.filter((r) => r.verdict === "fixed");
  if (fixed.length) improvement.push(`fixes ${fixed.length} case(s): ${fixed.map((r) => r.key).join(", ")}`);
  if (kind === "scope") {
    const covered = rows.filter((r) => r.extra && (r.verdict === "fixed" || r.verdict === "gained"));
    if (covered.length) improvement.push(`covers ${covered.length} new case(s): ${covered.map((r) => r.key).join(", ")}`);
  }
  if (kind === "performance" && faster === true) improvement.push(`faster: median ${newMedian} ms against ${oldMedian} ms over ${rows.filter((r) => r.new_ms !== null).length} run(s) on this host`);
  if (kind === "platform" && oldRunsHere === false && ran > 0 && counts.regression === 0) improvement.push(`runs on ${platformLabel()} where ${oldId} does not`);

  const report: CompareReport = {
    old: oldId,
    new: newId,
    platform: platformLabel(),
    host: hostLabel(),
    justification_kind: kind,
    cases: rows,
    counts,
    old_runs_here: oldRunsHere,
    latency: { new_median_ms: newMedian, old_median_ms: oldMedian, old_recorded_median_ms: oldRecorded, faster },
    blocking,
    improvement,
    dominates: blocking.length === 0 && improvement.length > 0,
    evidence: null,
  };
  if (opts.record === false) return report;

  const command = `whitesnake procedure compare ${oldId} ${newId}`;
  const inputHashes: Record<string, string> = {};
  for (const p of [oldP, newP]) {
    const abs = join(store.root, p.entrypoint);
    if (existsSync(abs)) inputHashes[p.entrypoint] = sha256(readFileSync(abs));
  }
  let body = JSON.stringify(report, null, 2);
  let truncated = false;
  if (body.length > 60_000) {
    body = `${body.slice(0, 60_000)}\n[truncated: ${body.length - 60_000} more characters]`;
    truncated = true;
  }
  const ev = createNode(
    store.root,
    "evidence",
    {
      title: `Comparison: ${newId} against ${oldId}`,
      kind: "execution",
      locator: { path: newP.entrypoint, section: command },
      execution: { command, cwd: ".", exit_code: 0, duration_ms: Date.now() - started, platform: platformLabel(), host: hostLabel(), input_hashes: inputHashes, truncated },
      produced_by: opts.episode ?? null,
    },
    body,
    { store },
  );
  return { ...report, evidence: ev.id };
}

export function renderCompare(r: CompareReport): string {
  const lines = [
    `${r.new} against ${r.old} on ${r.platform} (host ${r.host}): ${r.dominates ? "DOMINATES" : "does not dominate"}`,
    `  same ${r.counts.same}, fixed ${r.counts.fixed}, regression ${r.counts.regression}, still wrong ${r.counts.still_wrong}, changed unverified ${r.counts.changed_unverified}, agree ${r.counts.agree}, diverge ${r.counts.diverge}, gained ${r.counts.gained}, stale ${r.counts.stale}`,
    `  latency: new median ${r.latency.new_median_ms ?? "-"} ms, old median ${r.latency.old_median_ms ?? "-"} ms (recorded ${r.latency.old_recorded_median_ms ?? "-"} ms)${r.latency.faster === null ? "" : r.latency.faster ? ", new is faster" : ", new is not faster"}`,
    ...r.improvement.map((s) => `  improvement: ${s}`),
    ...r.blocking.map((s) => `  blocking: ${s}`),
    ...r.cases.map((c) => `  ${c.verdict.padEnd(18)} ${c.basis.padEnd(10)} ${c.key}  ${c.args.join(" ")}${c.note ? `  (${c.note})` : ""}`),
    r.evidence ? `  recorded as ${r.evidence}` : "  not recorded",
  ];
  return lines.join("\n");
}
