import type { Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { updateNode } from "../store/ops.js";
import { CliError, nowIso } from "../util.js";

export type ProcedureState = Procedure["state"];

/**
 * State transitions are computed here from recorded events and appended to `history`; the frontmatter `state`
 * is only a cache of the last entry, which the validator cross-checks. Nobody edits states by hand.
 */
export function transition(store: LoadedStore, procId: string, to: ProcedureState, reason: string, causedBy: string | null): Procedure {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  if (proc.state === to) return proc;
  const history = [...proc.history, { at: nowIso(), from: proc.state, to, caused_by: causedBy, reason }];
  return updateNode(store.root, procId, { state: to, history }, undefined, { store }) as Procedure;
}

/** A decision produced with this procedure was shown to the researcher and not corrected so far. */
export function recordShownUse(store: LoadedStore, procId: string, causedBy: string | null): { procedure: Procedure; promoted: boolean } {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  const counters = { ...proc.counters, shown_uses: proc.counters.shown_uses + 1 };
  let updated = updateNode(store.root, procId, { counters }, undefined, { store }) as Procedure;
  const threshold = store.config.promotion.shown_uses_to_trust;
  let promoted = false;
  if (updated.state === "provisional" && counters.corrections === 0 && counters.shown_uses >= threshold) {
    updated = transition(store, procId, "trusted", `${counters.shown_uses} results shown to the researcher without correction (threshold ${threshold})`, causedBy);
    promoted = true;
  }
  return { procedure: updated, promoted };
}

/** A decision produced with this procedure was corrected by the researcher. */
export function recordCorrection(store: LoadedStore, procId: string, reason: string, causedBy: string | null): Procedure {
  const proc = store.nodes.get(procId);
  if (!proc || proc.type !== "procedure") throw new CliError(`${procId} is not a procedure`, 1);
  const counters = { ...proc.counters, corrections: proc.counters.corrections + 1 };
  updateNode(store.root, procId, { counters }, undefined, { store });
  if (proc.state === "retired") return store.nodes.get(procId) as Procedure;
  return transition(store, procId, "suspended", `researcher correction: ${reason}`, causedBy);
}

/** Re-admit a suspended procedure after it was fixed: it starts again as provisional with counters reset. */
export function reinstate(store: LoadedStore, procId: string, reason: string, causedBy: string | null): Procedure {
  updateNode(store.root, procId, { counters: { shown_uses: 0, corrections: 0 } }, undefined, { store });
  return transition(store, procId, "provisional", `reinstated: ${reason}`, causedBy);
}

export function retire(store: LoadedStore, procId: string, reason: string, causedBy: string | null): Procedure {
  return transition(store, procId, "retired", reason, causedBy);
}
