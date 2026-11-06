import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { commitAll, openParentBranch } from "../branch.js";
import type { Decision, Node, Session } from "../schema/nodes.js";
import { loadConfig } from "../store/config.js";
import { loadStore, writeNodeFile, type LoadedStore } from "../store/files.js";
import { createNode } from "../store/ops.js";
import { CliError, nowIso } from "../util.js";
import { correctDecision } from "./correct.js";
import { markDelivered, pendingEvents, type OutboxEvent, type OutboxTurn } from "./outbox.js";
import { markShown } from "./shown.js";

/**
 * Deliver the queued acceptances and corrections to the child stores they concern. Each event is applied on this
 * store's branch of the child, exactly as a cross-store write would be: the turn it happened in is mirrored there in
 * reduced form, the event keeps its moment and its id, and the child's own rules do the rest. In the child's
 * sandbox a correction suspends what produced the value; on the child's main nothing moves, but a correction that
 * touches a procedure main also serves raises a question the child's researcher sees in `branch status`.
 */
export interface SyncResult {
  delivered: { event: string; kind: OutboxEvent["kind"]; store: string; target: string; branch: string; commit: string | null; question: string | null }[];
  pending: { event: string; kind: OutboxEvent["kind"]; store: string; target: string; reason: string }[];
}

/** The local directory of a child store, by its id or by its alias under `stores:`; null when it is not local. */
export function childRootForStoreId(parentRoot: string, storeId: string): string | null {
  const cfg = loadConfig(parentRoot);
  let byAlias: string | null = null;
  for (const [alias, p] of Object.entries(cfg.stores)) {
    const abs = isAbsolute(p) ? p : join(parentRoot, p);
    if (!existsSync(join(abs, "whitesnake.yaml"))) continue;
    try {
      if (loadConfig(abs).id === storeId) return abs;
    } catch {
      continue;
    }
    if (alias === storeId) byAlias = abs;
  }
  return byAlias;
}

/**
 * Mirror the turn an event happened in, reduced to what provenance needs: id, session, moment and prompt hash.
 * The prompt's text stays in the store it was typed in. Returns true when something was written.
 */
export function mirrorReducedTurn(targetRoot: string, turn: OutboxTurn, parentId: string): boolean {
  const store = loadStore(targetRoot);
  if (store.nodes.has(turn.id)) return false;
  if (!store.nodes.has(turn.session)) {
    const harness = turn.session.split("_")[1] ?? "";
    const session: Session = {
      id: turn.session,
      title: `Session of store ${parentId} (mirrored, reduced)`,
      created: turn.timestamp,
      created_by: `sync:${parentId}`,
      type: "session",
      harness: harness === "claude" || harness === "codex" ? harness : "stub",
      native_id: turn.session,
      cwd: "",
      git_branch: null,
      log_path: null,
      model: null,
      started: turn.timestamp,
      ended: null,
    };
    writeNodeFile(targetRoot, session, "");
  }
  const index = Number(turn.id.slice(turn.id.lastIndexOf("_") + 1)) || 1;
  const node: Node = {
    id: turn.id,
    title: `Turn ${index} of store ${parentId} (mirrored, reduced)`,
    created: turn.timestamp,
    created_by: `sync:${parentId}`,
    type: "turn",
    session: turn.session,
    index,
    native_id: null,
    prompt_excerpt: "",
    prompt_hash: turn.prompt_hash,
    timestamp: turn.timestamp,
  };
  writeNodeFile(targetRoot, node, "");
  return true;
}

/** When a remote correction hits a procedure the child's main also serves, the branch gets a question for the child's researcher. */
function sharedProcedureQuestion(store: LoadedStore, main: LoadedStore, decision: Decision, ev: OutboxEvent, parentId: string): string | null {
  if (!decision.produced_by) return null;
  const ep = store.nodes.get(decision.produced_by);
  if (!ep || ep.type !== "episode") return null;
  const shared = [...new Set(ep.uses)].filter((u) => main.nodes.get(u)?.type === "procedure").sort();
  if (!shared.length) return null;
  const title = `Remote correction by ${parentId} touches shared procedure ${shared.join(", ")}`;
  const existing = [...store.nodes.values()].find((n) => n.type === "question" && n.status === "open" && n.title === title);
  if (existing) return existing.id;
  const q = createNode(
    store.root,
    "question",
    {
      title,
      why: `The researcher of ${parentId} corrected ${decision.id} (${ev.reason ?? "no reason given"}). ${shared.join(", ")} also serves main: decide whether the defect is general, so the procedure must be corrected or superseded on main, or specific to this context, so its applicability should say so. Nothing on main moved.`,
      raised_in: ep.id,
      caused_by: ev.turn.id,
    },
    `Correction event ${ev.event}${ev.cell ? ` on ${ev.cell.unit}/${ev.cell.field}` : ""}${ev.value !== undefined ? `, value ${JSON.stringify(ev.value)}` : ""}.`,
    { store, causedBy: ev.turn.id, actor: `sync:${parentId}` },
  );
  return q.id;
}

export function syncOutbox(parentRoot: string, opts: { child?: string } = {}): SyncResult {
  const parentCfg = loadConfig(parentRoot);
  const result: SyncResult = { delivered: [], pending: [] };
  const mains = new Map<string, LoadedStore>();
  const only = opts.child ? childRootForStoreId(parentRoot, opts.child) : null;
  for (const ev of pendingEvents(parentRoot)) {
    const childRoot = childRootForStoreId(parentRoot, ev.target.store);
    if (opts.child && (childRoot === null ? opts.child !== ev.target.store : childRoot !== only)) continue;
    if (!childRoot) {
      result.pending.push({ event: ev.event, kind: ev.kind, store: ev.target.store, target: ev.target.id, reason: `store ${ev.target.store} is not registered under stores: as a local path` });
      continue;
    }
    try {
      const open = openParentBranch(childRoot, parentCfg.id);
      mirrorReducedTurn(open.worktree, ev.turn, parentCfg.id);
      const store = loadStore(open.worktree);
      const target = store.nodes.get(ev.target.id);
      if (!target || target.type !== "decision") throw new CliError(`${ev.target.id} is not a decision of ${ev.target.store}`, 1);
      let question: string | null = null;
      if (ev.kind === "shown") {
        markShown(store, [ev.target.id], ev.turn.id, { at: ev.at });
      } else {
        const sameCell = !!ev.cell && !!target.target && target.target.unit === ev.cell.unit && target.target.field === ev.cell.field;
        const r = correctDecision(store, ev.target.id, ev.reason ?? `corrected by the researcher of ${parentCfg.id}`, ev.turn.id, { value: sameCell ? ev.value : undefined, actor: `human:researcher@${parentCfg.id}`, event: ev.event, at: ev.at });
        if (!r.already) {
          let main = mains.get(childRoot);
          if (!main) {
            main = loadStore(childRoot);
            mains.set(childRoot, main);
          }
          question = sharedProcedureQuestion(store, main, target, ev, parentCfg.id);
        }
      }
      const commit = commitAll(open.worktree, `store: sync ${ev.kind} ${ev.event.slice(0, 12)} from ${parentCfg.id}`);
      markDelivered(parentRoot, { event: ev.event, store: ev.target.store, branch: open.branch, commit, delivered_at: nowIso() });
      result.delivered.push({ event: ev.event, kind: ev.kind, store: ev.target.store, target: ev.target.id, branch: open.branch, commit, question });
    } catch (e) {
      result.pending.push({ event: ev.event, kind: ev.kind, store: ev.target.store, target: ev.target.id, reason: (e as Error).message });
    }
  }
  return result;
}
