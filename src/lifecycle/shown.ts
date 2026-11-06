import { ensureIndex } from "../index/db.js";
import { remoteKey, type RemoteRef } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { updateNode } from "../store/ops.js";
import { nowIso } from "../util.js";
import { enqueue, remoteDecisionTargets, remoteTargetsForUnknownId, shownEventId, turnInfo, type OutboxEvent } from "./outbox.js";
import { recomputeProcedureCache } from "./procedures.js";

export interface ShownResult {
  shown: string[];
  already: string[];
  unknown: string[];
  promoted: string[];
  /** Acceptances queued for the records of other stores these decisions rest on; `sync` delivers them. */
  remote: { event: string; target: RemoteRef }[];
}

export const DECISION_ID_RE = /\bdec_[0-9a-z]{12}\b/g;

/**
 * Record that decisions were presented to the researcher during `turn`, at a given moment. The turn is required: a
 * shown use is a persisted event on the decision, so repeating the command in the same turn changes nothing. The
 * procedures the producing episode used derive a shown use from the first such event, which may promote them.
 */
export function markShown(store: LoadedStore, decisionIds: string[], turn: string, opts: { at?: string } = {}): ShownResult {
  const result: ShownResult = { shown: [], already: [], unknown: [], promoted: [], remote: [] };
  const at = opts.at ?? nowIso();
  const targets = new Map<string, RemoteRef>();
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
    for (const t of remoteDecisionTargets(store, d)) targets.set(remoteKey(t), t);
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
  if (result.unknown.length) {
    // An id this store does not hold may still be a record of another store, cited by a delegation here.
    const db = ensureIndex(store.root);
    for (const id of result.unknown) for (const t of remoteTargetsForUnknownId(db, id)) targets.set(remoteKey(t), t);
    db.close();
  }
  if (targets.size) {
    const info = turnInfo(store, turn);
    const events: OutboxEvent[] = [...targets.values()].map((t) => ({ event: shownEventId(t, turn), kind: "shown", target: t, turn: info, at, created: nowIso() }));
    result.remote = enqueue(store.root, events).map((e) => ({ event: e.event, target: e.target }));
  }
  return result;
}

/** Decision ids mentioned in a piece of text (the agent's final message, typically). */
export function decisionIdsIn(text: string): string[] {
  return [...new Set(text.match(DECISION_ID_RE) ?? [])];
}
