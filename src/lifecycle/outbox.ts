import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getNode } from "../index/queries.js";
import { REMOTE_SUFFIX } from "../schema/edges.js";
import { typeOfId } from "../schema/ids.js";
import { isRemoteRef, localIds, remoteKey, remoteRefs, type Decision, type RemoteRef } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { CliError, appendText, readText, sha256 } from "../util.js";

/**
 * Acceptances and corrections travel back to the stores whose records they concern. A shown or corrected decision
 * that rests on a record of another store queues one event per such record here; `sync` delivers them on this
 * store's branch of the child. The queue is operational state, outside the knowledge: append-only, never versioned.
 */
export const OUTBOX_FILE = ".whitesnake/outbox.jsonl";
export const DELIVERED_FILE = ".whitesnake/outbox-delivered.jsonl";

/** What the receiving store needs to mirror the turn an event happened in, without the prompt's text. */
export interface OutboxTurn {
  id: string;
  session: string;
  timestamp: string;
  prompt_hash: string;
}

export interface OutboxEvent {
  event: string;
  kind: "shown" | "corrected";
  target: RemoteRef;
  turn: OutboxTurn;
  /** The moment of the local event, carried so that the receiving store replays it in the same order. */
  at: string;
  /** Corrections: the local decision and its correction event. */
  origin?: { decision: string; event: string };
  reason?: string;
  value?: unknown;
  /** Corrections: the cell of the local decision; the value is forwarded only to a decision of the same cell. */
  cell?: { unit: string; field: string } | null;
  created: string;
}

export interface Delivery {
  event: string;
  store: string;
  branch: string;
  commit: string | null;
  delivered_at: string;
}

export function turnInfo(store: LoadedStore, turnId: string): OutboxTurn {
  const t = store.nodes.get(turnId);
  if (!t || t.type !== "turn") throw new CliError(`turn ${turnId} is not recorded in this store`, 1);
  return { id: t.id, session: t.session, timestamp: t.timestamp, prompt_hash: t.prompt_hash };
}

/** The decisions of other stores a decision rests on: its own remote references, and those its evidence cites. */
export function remoteDecisionTargets(store: LoadedStore, decision: Decision): RemoteRef[] {
  const out = new Map<string, RemoteRef>();
  const add = (r: RemoteRef): void => {
    if (typeOfId(r.id) === "decision" && !out.has(remoteKey(r))) out.set(remoteKey(r), r);
  };
  for (const r of [...remoteRefs(decision.depends_on), ...remoteRefs(decision.backing), ...remoteRefs(decision.data)]) add(r);
  for (const id of localIds(decision.data)) {
    const e = store.nodes.get(id);
    if (e && e.type === "evidence") for (const r of remoteRefs(e.cites)) add(r);
  }
  return [...out.values()];
}

/** A decision id unknown here but cited by a remote edge: the records of other stores it names. */
export function remoteTargetsForUnknownId(db: DatabaseSync, id: string): RemoteRef[] {
  if (typeOfId(id) !== "decision") return [];
  const rows = db.prepare(`SELECT src, rel, dst FROM edges WHERE rel LIKE '%${REMOTE_SUFFIX}' AND dst LIKE ? ORDER BY src, rel`).all(`%:${id}`) as { src: string; rel: string; dst: string }[];
  const out = new Map<string, RemoteRef>();
  for (const row of rows) {
    const base = row.rel.slice(0, -REMOTE_SUFFIX.length);
    const src = getNode(db, row.src);
    const refs = src ? (src as unknown as Record<string, unknown>)[base] : undefined;
    const ref = Array.isArray(refs) ? refs.find((r) => isRemoteRef(r) && remoteKey(r) === row.dst) : undefined;
    if (isRemoteRef(ref) && !out.has(row.dst)) out.set(row.dst, ref);
  }
  return [...out.values()];
}

export function shownEventId(target: RemoteRef, turn: string): string {
  return sha256(`shown:${remoteKey(target)}:${turn}`);
}

export function correctedEventId(target: RemoteRef, correction: string): string {
  return sha256(`corrected:${remoteKey(target)}:${correction}`);
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readText(path)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function readOutbox(root: string): OutboxEvent[] {
  return readLines<OutboxEvent>(join(root, OUTBOX_FILE));
}

export function readDeliveries(root: string): Delivery[] {
  return readLines<Delivery>(join(root, DELIVERED_FILE));
}

/** Append the events not yet queued; returns the ones added. */
export function enqueue(root: string, events: OutboxEvent[]): OutboxEvent[] {
  const known = new Set(readOutbox(root).map((e) => e.event));
  const added: OutboxEvent[] = [];
  for (const ev of events) {
    if (known.has(ev.event)) continue;
    known.add(ev.event);
    appendText(join(root, OUTBOX_FILE), `${JSON.stringify(ev)}\n`);
    added.push(ev);
  }
  return added;
}

export function pendingEvents(root: string): OutboxEvent[] {
  const delivered = new Set(readDeliveries(root).map((d) => d.event));
  return readOutbox(root).filter((e) => !delivered.has(e.event));
}

export function markDelivered(root: string, delivery: Delivery): void {
  appendText(join(root, DELIVERED_FILE), `${JSON.stringify(delivery)}\n`);
}
