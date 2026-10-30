import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision, Episode, Evidence, Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { sha256 } from "../util.js";
import { tokenize } from "./propose.js";
import { parseOutput, readRegressionCase } from "./regression.js";

/**
 * How the store rates the value a procedure produced on one input: a regression file states it (`expected`); the
 * researcher saw it and let it stand (`accepted`); the researcher corrected it (`corrected`); nobody confirmed it, or
 * the criterion behind it changed since (`unverified`); the procedure failed on that input (`abstained`).
 */
export type Basis = "expected" | "accepted" | "corrected" | "unverified" | "abstained";

export interface BatteryCase {
  /** Regression file path, or the id of the execution evidence. */
  key: string;
  source: "regression" | "execution";
  args: string[];
  basis: Basis;
  /** Regression: the expected value. Execution: the output that was recorded. */
  reference: unknown;
  /** `total` when a regression file uses `expected_total`. */
  project: "total" | null;
  /** Present when a correction supplied the right value. */
  corrected_value?: unknown;
  decision: string | null;
  evidence: string | null;
  episode: string | null;
  recorded_duration_ms: number | null;
  recorded_platform: string | null;
  /** Whether the recorded execution ran the code version the record registers; null when either hash is unknown. */
  code_hash_matches: boolean | null;
  /** Why the case cannot be replayed (an input changed or vanished, the recorded output was cut). */
  stale: string | null;
}

/** Episodes that list the procedure among what they used, oldest first. */
export function episodesUsing(store: LoadedStore, procId: string): Episode[] {
  return [...store.nodes.values()]
    .filter((n): n is Episode => n.type === "episode" && n.uses.includes(procId))
    .sort((a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id));
}

/** Decisions an episode produced. */
export function decisionsOf(store: LoadedStore, episodeId: string): Decision[] {
  return [...store.nodes.values()]
    .filter((n): n is Decision => n.type === "decision" && n.produced_by === episodeId)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

/** Positional arguments that followed the entrypoint in a recorded command; null when the command does not name it. */
export function argsAfterEntrypoint(command: string, entrypoint: string): string[] | null {
  const tokens = tokenize(command);
  const at = tokens.findIndex((t) => t === entrypoint || t === `./${entrypoint}`);
  return at < 0 ? null : tokens.slice(at + 1);
}

export type RecordedExecution = Evidence & { execution: NonNullable<Evidence["execution"]> };

/** Recorded executions of the procedure's entrypoint produced inside an episode. */
export function executionsOf(store: LoadedStore, episodeId: string, proc: Procedure): RecordedExecution[] {
  return [...store.nodes.values()]
    .filter((n): n is RecordedExecution => n.type === "evidence" && n.kind === "execution" && n.execution !== null && n.produced_by === episodeId && argsAfterEntrypoint(n.execution.command, proc.entrypoint) !== null)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

/** The value the researcher put in place of one of these decisions, when the correction carried one. */
function correctedValueFor(store: LoadedStore, decisions: Decision[]): { value: unknown; decision: string } | undefined {
  const ids = new Set(decisions.map((d) => d.id));
  const replacement = [...store.nodes.values()]
    .filter((n): n is Decision => n.type === "decision" && n.target !== null && n.supersedes.some((s) => ids.has(s)))
    .sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id))[0];
  return replacement && replacement.target ? { value: replacement.target.value, decision: replacement.id } : undefined;
}

const PRIORITY: Record<Basis, number> = { corrected: 4, accepted: 3, unverified: 2, abstained: 1, expected: 0 };

/**
 * Everything the store can replay about a procedure: its regression cases, then one case per distinct input it was
 * run on, each carrying what the researcher did with the value it produced. Nothing here is written by hand.
 */
export function deriveBattery(store: LoadedStore, proc: Procedure): BatteryCase[] {
  const out: BatteryCase[] = [];
  for (const rel of proc.regression_cases) {
    const c = readRegressionCase(store, rel);
    out.push({ key: rel, source: "regression", args: c.args, basis: "expected", reference: c.expected, project: c.key, decision: null, evidence: null, episode: null, recorded_duration_ms: null, recorded_platform: null, code_hash_matches: null, stale: c.error ?? null });
  }
  const byArgs = new Map<string, BatteryCase>();
  for (const ep of episodesUsing(store, proc.id)) {
    const decisions = decisionsOf(store, ep.id);
    for (const ev of executionsOf(store, ep.id, proc)) {
      const args = argsAfterEntrypoint(ev.execution.command, proc.entrypoint) ?? [];
      let basis: Basis;
      let corrected: { value: unknown; decision: string } | undefined;
      let decision: string | null = null;
      if (ev.execution.exit_code !== 0) {
        basis = "abstained";
      } else if (ep.outcome === "corrected") {
        basis = "corrected";
        corrected = correctedValueFor(store, decisions);
        decision = decisions[0]?.id ?? null;
      } else {
        const accepted = decisions.find((d) => d.status === "active" && d.shown_at.length > 0);
        basis = accepted ? "accepted" : "unverified";
        decision = accepted?.id ?? decisions[0]?.id ?? null;
      }
      const stale: string[] = [];
      if (ev.execution.truncated) stale.push("recorded output truncated");
      for (const [path, hash] of Object.entries(ev.execution.input_hashes)) {
        if (path === proc.entrypoint) continue;
        const abs = join(store.root, path);
        if (!existsSync(abs)) stale.push(`input missing: ${path}`);
        else if (sha256(readFileSync(abs)) !== hash) stale.push(`input changed: ${path}`);
      }
      const recordedCode = ev.execution.input_hashes[proc.entrypoint];
      const c: BatteryCase = {
        key: ev.id,
        source: "execution",
        args,
        basis,
        reference: parseOutput(store.bodies.get(ev.id) ?? ""),
        project: null,
        ...(corrected ? { corrected_value: corrected.value } : {}),
        decision,
        evidence: ev.id,
        episode: ep.id,
        recorded_duration_ms: ev.execution.duration_ms,
        recorded_platform: ev.execution.platform,
        code_hash_matches: recordedCode && proc.code_hash ? recordedCode === proc.code_hash : null,
        stale: stale.length ? stale.join("; ") : null,
      };
      const k = JSON.stringify(args);
      const prev = byArgs.get(k);
      if (!prev || PRIORITY[c.basis] > PRIORITY[prev.basis]) byArgs.set(k, c);
    }
  }
  out.push(...[...byArgs.values()].sort((a, b) => a.key.localeCompare(b.key)));
  return out;
}
