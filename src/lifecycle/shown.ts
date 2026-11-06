import type { LoadedStore } from "../store/files.js";
import { updateNode } from "../store/ops.js";
import { nowIso } from "../util.js";
import { recomputeProcedureCache } from "./procedures.js";

export interface ShownResult {
  shown: string[];
  already: string[];
  unknown: string[];
  promoted: string[];
}

export const DECISION_ID_RE = /\bdec_[0-9a-z]{12}\b/g;

/**
 * Record that decisions were presented to the researcher during `turn`, at a given moment. The turn is required: a
 * shown use is a persisted event on the decision, so repeating the command in the same turn changes nothing. The
 * procedures the producing episode used derive a shown use from the first such event, which may promote them.
 */
export function markShown(store: LoadedStore, decisionIds: string[], turn: string, opts: { at?: string } = {}): ShownResult {
  const result: ShownResult = { shown: [], already: [], unknown: [], promoted: [] };
  const at = opts.at ?? nowIso();
  for (const id of [...new Set(decisionIds)]) {
    const d = store.nodes.get(id);
    if (!d || d.type !== "decision") {
      result.unknown.push(id);
      continue;
    }
    if (d.shown_at.some((s) => s.turn === turn)) {
      result.already.push(id);
      continue;
    }
    updateNode(store.root, id, { shown_at: [...d.shown_at, { turn, at }] }, undefined, { store });
    result.shown.push(id);
    if (!d.produced_by) continue;
    const ep = store.nodes.get(d.produced_by);
    if (!ep || ep.type !== "episode") continue;
    for (const used of new Set(ep.uses)) {
      const u = store.nodes.get(used);
      if (!u || u.type !== "procedure") continue;
      const r = recomputeProcedureCache(store, used);
      if (r.from === "provisional" && r.to === "trusted") result.promoted.push(used);
    }
  }
  return result;
}

/** Decision ids mentioned in a piece of text (the agent's final message, typically). */
export function decisionIdsIn(text: string): string[] {
  return [...new Set(text.match(DECISION_ID_RE) ?? [])];
}
