import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Decision, Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";

/**
 * A procedure's state, counters and history are derived from recorded events, never incremented in place: the
 * decisions shown to the researcher (`shown_at`), the corrections they received (`corrections`) and the choice
 * decisions that record an explicit transition (`transition`). The frontmatter fields are a cache of this replay,
 * checked for equality by the validator and rewritten by `recomputeProcedureCache`. Two branches that use the same
 * procedure therefore never fight over a counter line: their events add up when the branches meet.
 */

export type ProcedureState = Procedure["state"];
export type ProcedureEventKind = "shown" | "corrected" | "reinstate" | "retire" | "supersede" | "suspend";

/** One recorded fact about a procedure, with the moment it happened and the record it comes from. */
export interface ProcedureEvent {
  kind: ProcedureEventKind;
  at: string;
  /** The decision for shown and explicit transitions, the correction's event id for corrections. */
  source: string;
  /** What the derived history entry cites: the turn of a shown or corrected decision, the choice decision of an explicit transition. */
  caused_by: string | null;
  reason: string;
  actor: string | null;
  /** A correction moves the state only when its actor owns the branch context; the others are counted by the scorecard. */
  counts: boolean;
}

export interface DeriveContext {
  branch: string | null;
  /** The actor whose corrections move the state here: the store's researcher on main, the parent's researcher on its branch. */
  owner: string;
}

export interface DerivedProcedure {
  state: ProcedureState;
  counters: { shown_uses: number; corrections: number };
  history: Procedure["history"];
  events: ProcedureEvent[];
  /** Explicit transitions the rules do not admit from the state they found: reported, never applied. */
  warnings: { decision: string; message: string }[];
}

/** States in which a procedure is offered for new work and accumulates shown uses. */
export const LIVE_STATES: readonly ProcedureState[] = ["provisional", "trusted"];

/** At equal moments: what was shown, then what was corrected, then what was decided explicitly. */
const PRIORITY: Record<ProcedureEventKind, number> = { shown: 1, corrected: 2, reinstate: 3, retire: 3, supersede: 3, suspend: 3 };
const TRANSITION_KIND: Record<NonNullable<Decision["transition"]>["to"], ProcedureEventKind> = { provisional: "reinstate", suspended: "suspend", retired: "retire", superseded: "supersede" };

export function ownerFor(branch: string | null): string {
  return branch && branch.startsWith("parent/") ? `human:researcher@${branch.slice("parent/".length)}` : "human:researcher";
}

const contexts = new Map<string, DeriveContext>();

/** The branch a store directory is on: a parent worktree by its path, otherwise git's answer, otherwise main. Memoised per directory. */
export function branchContext(root: string): DeriveContext {
  const cached = contexts.get(root);
  if (cached) return cached;
  let branch: string | null = null;
  if (basename(dirname(root)) === "worktrees" && basename(dirname(dirname(root))) === ".whitesnake") {
    branch = `parent/${basename(root)}`;
  } else if (existsSync(join(root, ".git"))) {
    const r = spawnSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
    const name = (r.stdout ?? "").trim();
    if (r.status === 0 && name && name !== "HEAD") branch = name;
  }
  const ctx = { branch, owner: ownerFor(branch) };
  contexts.set(root, ctx);
  return ctx;
}

/** Every procedure's events in one pass over the store, keyed by procedure id. */
export function collectEvents(store: LoadedStore, ctx: DeriveContext): Map<string, ProcedureEvent[]> {
  const out = new Map<string, ProcedureEvent[]>();
  const push = (proc: string, ev: ProcedureEvent): void => {
    const list = out.get(proc) ?? [];
    list.push(ev);
    out.set(proc, list);
  };
  const turnTime = (id: string | null): string | null => {
    if (!id) return null;
    const t = store.nodes.get(id);
    return t && t.type === "turn" ? t.timestamp : null;
  };
  for (const n of store.nodes.values()) {
    if (n.type !== "decision") continue;
    if (n.transition) {
      push(n.transition.procedure, { kind: TRANSITION_KIND[n.transition.to], at: n.created, source: n.id, caused_by: n.id, reason: n.transition.reason, actor: n.created_by, counts: true });
    }
    if (!n.produced_by) continue;
    const ep = store.nodes.get(n.produced_by);
    if (!ep || ep.type !== "episode") continue;
    const procs = [...new Set(ep.uses)].filter((u) => store.nodes.get(u)?.type === "procedure");
    if (!procs.length) continue;
    const first = n.shown_at[0];
    if (first) {
      // The first time a decision was shown is the one that counts, as a use of what produced it.
      const at = first.at ?? turnTime(first.turn) ?? n.created;
      for (const p of procs) push(p, { kind: "shown", at, source: n.id, caused_by: first.turn, reason: `${n.id} shown to the researcher`, actor: null, counts: true });
    }
    for (const c of n.corrections) {
      for (const p of procs) push(p, { kind: "corrected", at: c.at, source: c.event, caused_by: c.turn, reason: `researcher correction: ${c.reason}`, actor: c.actor, counts: c.actor === ctx.owner });
    }
  }
  return out;
}

/**
 * Replay a procedure's events in time order and derive its state, counters and history. Creation is always first;
 * ties are broken by kind, then by the source record, so the result never depends on file order or on the order in
 * which events reached this store.
 */
export function replay(proc: Procedure, events: ProcedureEvent[], threshold: number): DerivedProcedure {
  const creation = proc.history.find((h) => h.from === null);
  const history: Procedure["history"] = [{ at: creation?.at ?? proc.created, from: null, to: "provisional", caused_by: creation?.caused_by ?? proc.caused_by, reason: creation?.reason ?? "registered" }];
  let state = "provisional" as ProcedureState;
  let shown = 0;
  let corrections = 0;
  const warnings: DerivedProcedure["warnings"] = [];
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at) || PRIORITY[a.kind] - PRIORITY[b.kind] || a.source.localeCompare(b.source));
  const live = (): boolean => LIVE_STATES.includes(state);
  const move = (to: ProcedureState, ev: ProcedureEvent, reason: string): void => {
    history.push({ at: ev.at, from: state, to, caused_by: ev.caused_by, reason });
    state = to;
  };
  const ignore = (ev: ProcedureEvent, to: ProcedureState): void => {
    warnings.push({ decision: ev.source, message: `${ev.source} records a transition of ${proc.id} to ${to}, which the rules do not admit from ${state}; the transition is ignored` });
  };
  for (const ev of ordered) {
    switch (ev.kind) {
      case "shown":
        if (!live()) break;
        shown++;
        if (state === "provisional" && corrections === 0 && shown >= threshold) move("trusted", ev, `${shown} results shown to the researcher without correction (threshold ${threshold})`);
        break;
      case "corrected":
        if (!ev.counts) break;
        corrections++;
        if (live()) move("suspended", ev, ev.reason);
        break;
      case "suspend":
        if (live()) move("suspended", ev, ev.reason);
        else ignore(ev, "suspended");
        break;
      case "reinstate":
        if (state === "suspended" || state === "superseded" || state === "retired") {
          shown = 0;
          corrections = 0;
          move("provisional", ev, `reinstated: ${ev.reason}`);
        } else ignore(ev, "provisional");
        break;
      case "retire":
        if (live()) move("retired", ev, ev.reason);
        else ignore(ev, "retired");
        break;
      case "supersede":
        if (live() || state === "suspended") move("superseded", ev, ev.reason);
        else ignore(ev, "superseded");
        break;
    }
  }
  return { state, counters: { shown_uses: shown, corrections }, history, events: ordered, warnings };
}

export function deriveProcedure(store: LoadedStore, procId: string, ctx: DeriveContext = branchContext(store.root)): DerivedProcedure {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new Error(`${procId} is not a procedure`);
  return replay(proc, collectEvents(store, ctx).get(procId) ?? [], store.config.promotion.shown_uses_to_trust);
}

/** Whether the cached fields agree with a derivation: state and counters exactly, history on its sequence of states. */
export function cacheEquals(proc: Procedure, d: DerivedProcedure): { state: boolean; counters: boolean; history: boolean } {
  return {
    state: proc.state === d.state,
    counters: proc.counters.shown_uses === d.counters.shown_uses && proc.counters.corrections === d.counters.corrections,
    history: stateSequence(proc.history) === stateSequence(d.history),
  };
}

export function stateSequence(history: Procedure["history"]): string {
  return history.map((h) => h.to).join(" > ");
}
