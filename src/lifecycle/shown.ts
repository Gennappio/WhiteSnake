import type { LoadedStore } from "../store/files.js";
import { updateNode } from "../store/ops.js";
import { recordShownUse } from "./procedures.js";

export interface ShownResult {
  shown: string[];
  already: string[];
  unknown: string[];
  promoted: string[];
}

export const DECISION_ID_RE = /\bdec_[0-9a-z]{12}\b/g;

/**
 * Record that decisions were presented to the researcher during `turn`. The turn is required: a shown use is a
 * persisted event on the decision, so repeating the command in the same turn changes nothing. The first time a
 * decision is shown, every procedure its producing episode used earns one shown use, which may promote it to trusted.
 */
export function markShown(store: LoadedStore, decisionIds: string[], turn: string): ShownResult {
  const result: ShownResult = { shown: [], already: [], unknown: [], promoted: [] };
  for (const id of [...new Set(decisionIds)]) {
    const d = store.nodes.get(id);
    if (!d || d.type !== "decision") {
      result.unknown.push(id);
      continue;
    }
    if (d.shown_at.includes(turn)) {
      result.already.push(id);
      continue;
    }
    const firstTime = d.shown_at.length === 0;
    updateNode(store.root, id, { shown_at: [...d.shown_at, turn] }, undefined, { store });
    result.shown.push(id);
    if (firstTime && d.produced_by) {
      const ep = store.nodes.get(d.produced_by);
      if (ep && ep.type === "episode") {
        for (const used of ep.uses) {
          const u = store.nodes.get(used);
          if (u && u.type === "procedure") {
            const { promoted } = recordShownUse(store, used, turn);
            if (promoted) result.promoted.push(used);
          }
        }
      }
    }
  }
  return result;
}

/** Decision ids mentioned in a piece of text (the agent's final message, typically). */
export function decisionIdsIn(text: string): string[] {
  return [...new Set(text.match(DECISION_ID_RE) ?? [])];
}
