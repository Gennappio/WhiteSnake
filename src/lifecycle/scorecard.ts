import type { Decision, Procedure, THRESHOLD_METRICS } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { CliError } from "../util.js";
import { decisionsOf, episodesUsing, executionsOf } from "./battery.js";
import { hostLabel, platformLabel } from "./regression.js";

export type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];

export interface LatencyGroup {
  platform: string;
  host: string | null;
  n: number;
  median_ms: number;
  max_ms: number;
}

export interface ThresholdEval {
  criterion: string;
  title: string;
  metric: ThresholdMetric;
  max: number;
  min_shown: number;
  value: number | null;
  observed: number;
  /** met: the bar is cleared; violated: it is not; insufficient: too few observed outputs to say; unavailable: nothing measured. */
  status: "met" | "violated" | "insufficient" | "unavailable";
}

/** Measurements derived from the records; nothing here is stored or decided by hand. */
export interface Scorecard {
  procedure: string;
  title: string;
  state: Procedure["state"];
  resolution: Procedure["resolution"];
  entrypoint: string;
  code_hash: string | null;
  code_archived: Procedure["code_archived"];
  supersedes: string[];
  superseded_by: string[];
  justification: Procedure["justification"];
  use: { episodes: number; sessions: number; first: string | null; last: string | null; outcomes: Record<string, number> };
  outputs: {
    decisions: number;
    shown: number;
    corrected: number;
    /** Decisions the researcher saw or corrected: the only ones that can reveal an error. */
    observed: number;
    /** corrected over observed; a lower bound of the real error, since unobserved outputs tell nothing. */
    observed_error_rate: number | null;
  };
  regression: { cases: number; check_failures: { at: string; reason: string }[] };
  latency: LatencyGroup[];
  /** Distinct hashes of the entrypoint seen in recorded executions: more than one means the code changed under this record. */
  code_versions: string[];
  thresholds: ThresholdEval[];
  counters: Procedure["counters"];
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function count(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of [...items].sort()) out[i] = (out[i] ?? 0) + 1;
  return out;
}

/** Active threshold criteria that apply to a procedure: those naming it, or naming no procedure at all. */
export function thresholdCriteria(store: LoadedStore, procId: string): Decision[] {
  return [...store.nodes.values()]
    .filter((n): n is Decision => n.type === "decision" && n.kind === "criterion" && n.status === "active" && n.threshold !== null && (n.threshold.procedures.length === 0 || n.threshold.procedures.includes(procId)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function evaluateThresholds(store: LoadedStore, procId: string, m: { observed_error_rate: number | null; observed: number; median_duration_ms: number | null }): ThresholdEval[] {
  return thresholdCriteria(store, procId).map((c) => {
    const t = c.threshold!;
    const value = t.metric === "observed_error_rate" ? m.observed_error_rate : m.median_duration_ms;
    let status: ThresholdEval["status"];
    if (m.observed < t.min_shown) status = "insufficient";
    else if (value === null) status = "unavailable";
    else status = value <= t.max ? "met" : "violated";
    return { criterion: c.id, title: c.title, metric: t.metric, max: t.max, min_shown: t.min_shown, value, observed: m.observed, status };
  });
}

export function scorecard(store: LoadedStore, procId: string): Scorecard {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  const turnSession = new Map<string, string>();
  for (const n of store.nodes.values()) if (n.type === "turn") turnSession.set(n.id, n.session);
  const eps = episodesUsing(store, procId);
  const sessions = new Set(eps.map((e) => (e.caused_by ? turnSession.get(e.caused_by) : undefined)).filter((s): s is string => !!s));
  const decisions = eps.flatMap((e) => decisionsOf(store, e.id));
  const correctedEpisodes = new Set(eps.filter((e) => e.outcome === "corrected").map((e) => e.id));
  const shown = decisions.filter((d) => d.shown_at.length > 0);
  const corrected = decisions.filter((d) => d.produced_by !== null && correctedEpisodes.has(d.produced_by));
  const observed = new Set([...shown, ...corrected].map((d) => d.id)).size;
  const rate = observed ? corrected.length / observed : null;

  const executions = eps.flatMap((e) => executionsOf(store, e.id, proc));
  const groups = new Map<string, { platform: string; host: string | null; durations: number[] }>();
  for (const ev of executions) {
    if (ev.execution.duration_ms === null) continue;
    const platform = ev.execution.platform ?? "unknown";
    const key = `${platform}|${ev.execution.host ?? ""}`;
    const g = groups.get(key) ?? { platform, host: ev.execution.host, durations: [] };
    g.durations.push(ev.execution.duration_ms);
    groups.set(key, g);
  }
  const latency: LatencyGroup[] = [...groups.values()]
    .map((g) => ({ platform: g.platform, host: g.host, n: g.durations.length, median_ms: median(g.durations)!, max_ms: Math.max(...g.durations) }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || (a.host ?? "").localeCompare(b.host ?? ""));
  const here = latency.find((g) => g.platform === platformLabel() && g.host === hostLabel()) ?? latency.find((g) => g.platform === platformLabel());
  const codeVersions = [...new Set(executions.map((ev) => ev.execution.input_hashes[proc.entrypoint]).filter((h): h is string => !!h))].sort();

  return {
    procedure: proc.id,
    title: proc.title,
    state: proc.state,
    resolution: proc.resolution,
    entrypoint: proc.entrypoint,
    code_hash: proc.code_hash,
    code_archived: proc.code_archived,
    supersedes: proc.supersedes,
    superseded_by: [...store.nodes.values()].filter((n): n is Procedure => n.type === "procedure" && n.supersedes.includes(procId)).map((n) => n.id).sort(),
    justification: proc.justification,
    use: { episodes: eps.length, sessions: sessions.size, first: eps[0]?.started ?? null, last: eps[eps.length - 1]?.started ?? null, outcomes: count(eps.map((e) => e.outcome)) },
    outputs: { decisions: decisions.length, shown: shown.length, corrected: corrected.length, observed, observed_error_rate: rate },
    regression: { cases: proc.regression_cases.length, check_failures: proc.history.filter((h) => h.to === "suspended" && h.reason.startsWith("regression failed on")).map((h) => ({ at: h.at, reason: h.reason })) },
    latency,
    code_versions: codeVersions,
    thresholds: evaluateThresholds(store, procId, { observed_error_rate: rate, observed, median_duration_ms: here?.median_ms ?? null }),
    counters: proc.counters,
  };
}

export function renderScorecard(s: Scorecard): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  return [
    `${s.procedure} (${s.state}, ${s.resolution}) ${s.title}`,
    `  code: ${s.entrypoint}${s.code_hash ? ` sha256 ${s.code_hash.slice(0, 12)}…` : " (no hash registered)"}${s.code_archived ? ` archived at commit ${s.code_archived.commit.slice(0, 8)}` : ""}${s.code_versions.length > 1 ? `; ${s.code_versions.length} code versions seen in executions` : ""}`,
    s.supersedes.length ? `  supersedes: ${s.supersedes.join(", ")}${s.justification ? ` (${s.justification.kind}: ${s.justification.text || s.justification.evidence.join(", ")})` : ""}` : "",
    s.superseded_by.length ? `  superseded by: ${s.superseded_by.join(", ")}` : "",
    `  use: ${s.use.episodes} episode(s) in ${s.use.sessions} session(s)${s.use.first ? `, ${s.use.first.slice(0, 10)} to ${(s.use.last ?? s.use.first).slice(0, 10)}` : ""}; outcomes ${Object.entries(s.use.outcomes).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    `  outputs: ${s.outputs.decisions} decision(s), ${s.outputs.shown} shown, ${s.outputs.corrected} corrected; observed error ${pct(s.outputs.observed_error_rate)} over ${s.outputs.observed} observed (a lower bound)`,
    `  regression: ${s.regression.cases} case(s)${s.regression.check_failures.length ? `; failed check ${s.regression.check_failures.length} time(s): ${s.regression.check_failures.map((f) => f.at.slice(0, 10)).join(", ")}` : ""}`,
    `  latency: ${s.latency.length ? s.latency.map((g) => `${g.platform}${g.host ? ` @${g.host}` : ""}: median ${g.median_ms} ms, max ${g.max_ms} ms over ${g.n}`).join("; ") : "no recorded execution with a duration"}`,
    `  thresholds: ${s.thresholds.length ? s.thresholds.map((t) => `${t.criterion} ${t.metric} <= ${t.max}${t.min_shown ? ` after ${t.min_shown} observed` : ""}: ${t.status}${t.value !== null ? ` (${t.metric === "observed_error_rate" ? pct(t.value) : `${t.value} ms`})` : ""}`).join("; ") : "none declared; the default rule applies (never worse on a recorded case, better on one)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}
