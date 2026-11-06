import type { Decision, Procedure, TRANSITION_TARGETS } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode, updateNode } from "../store/ops.js";
import { CliError } from "../util.js";
import { LIVE_STATES, branchContext, cacheEquals, deriveProcedure, type DeriveContext, type ProcedureState } from "./derive.js";

export { LIVE_STATES, type ProcedureState };
export type TransitionTarget = (typeof TRANSITION_TARGETS)[number];

export interface RecomputeResult {
  id: string;
  changed: boolean;
  from: ProcedureState;
  to: ProcedureState;
  warnings: string[];
}

/**
 * Rewrite the cached `state`, `counters` and `history` of a procedure from its recorded events (see derive.ts).
 * Nobody edits these fields by hand and no command increments them: every writer records its event, then calls this.
 */
export function recomputeProcedureCache(store: LoadedStore, procId: string, ctx?: DeriveContext): RecomputeResult {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  const derived = deriveProcedure(store, procId, ctx ?? branchContext(store.root));
  const eq = cacheEquals(proc, derived);
  const sameHistory = eq.history && JSON.stringify(proc.history) === JSON.stringify(derived.history);
  const changed = !(eq.state && eq.counters && sameHistory);
  if (changed) updateNode(store.root, procId, { state: derived.state, counters: derived.counters, history: derived.history }, undefined, { store });
  return { id: procId, changed, from: proc.state, to: derived.state, warnings: derived.warnings.map((w) => w.message) };
}

/** Recompute every procedure's cache (or the ones named), in id order. */
export function recomputeAll(store: LoadedStore, ids?: string[], ctx?: DeriveContext): RecomputeResult[] {
  const targets = ids ?? [...store.nodes.values()].filter((n) => n.type === "procedure").map((n) => n.id).sort();
  const context = ctx ?? branchContext(store.root);
  return targets.map((id) => recomputeProcedureCache(store, id, context));
}

const TITLE: Record<TransitionTarget, string> = { provisional: "Reinstatement", suspended: "Suspension", retired: "Retirement", superseded: "Supersession" };
const VERB: Record<TransitionTarget, string> = { provisional: "is reinstated", suspended: "is suspended", retired: "is retired", superseded: "is superseded" };

/**
 * An explicit transition is a choice decision: it names the procedure in `depends_on`, carries the transition the CLI
 * reads, and cites what justifies it (evidence in `data`, decisions in `backing`). The derivation turns it into an
 * event; the cache follows.
 */
export function recordTransitionDecision(store: LoadedStore, procId: string, to: TransitionTarget, reason: string, causedBy: string | null, opts: { evidence?: string[]; actor?: string; title?: string; producedBy?: string | null } = {}): Decision {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  const data: string[] = [];
  const backing: string[] = [];
  for (const id of opts.evidence ?? []) {
    const n = store.nodes.get(id);
    if (!n) throw new CliError(`unknown record ${id}`, 1);
    if (n.type === "evidence") data.push(id);
    else if (n.type === "decision") backing.push(id);
    else throw new CliError(`${id} is a ${n.type}; a transition cites evidence or decisions`, 1);
  }
  return createNode(
    store.root,
    "decision",
    {
      title: opts.title ?? `${TITLE[to]}: ${procId}`,
      kind: "choice",
      status: "active",
      claim: `${procId} ${VERB[to]}: ${reason}`,
      qualifier: { confidence: 1, scope: "procedures of this store" },
      fragility: "mechanical",
      target: null,
      data,
      backing,
      depends_on: [procId],
      produced_by: opts.producedBy ?? null,
      transition: { procedure: procId, to, reason },
    },
    reason,
    { store, causedBy, actor: opts.actor },
  ) as Decision;
}

/** Re-admit a suspended, superseded or retired procedure: it starts again as provisional with its counters reset. */
export function reinstate(store: LoadedStore, procId: string, reason: string, causedBy: string | null, opts: { evidence: string[]; actor?: string }): Procedure {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  if (proc.state !== "suspended" && proc.state !== "superseded" && proc.state !== "retired") throw new CliError(`${procId} is ${proc.state}; only a suspended, superseded or retired procedure can be reinstated`, 2);
  if (!opts.evidence.length) throw new CliError(`reinstating ${procId} needs evidence (--evidence <ids...>): the records that show what was fixed, or the recheck a new model failed`, 1);
  recordTransitionDecision(store, procId, "provisional", reason, causedBy, { evidence: opts.evidence, actor: opts.actor });
  recomputeProcedureCache(store, procId);
  return store.nodes.get(procId) as Procedure;
}

/** Stop using a live procedure; its outputs stand. The sublation check (`recheck`) cites its own evidence here. */
export function retire(store: LoadedStore, procId: string, reason: string, causedBy: string | null, opts: { evidence?: string[]; actor?: string } = {}): Procedure {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  if (!LIVE_STATES.includes(proc.state)) throw new CliError(`${procId} is ${proc.state}; only a provisional or trusted procedure can be retired`, 2);
  recordTransitionDecision(store, procId, "retired", reason, causedBy, { evidence: opts.evidence ?? [], actor: opts.actor });
  recomputeProcedureCache(store, procId);
  return store.nodes.get(procId) as Procedure;
}
