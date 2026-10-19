import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { openParentBranch } from "../branch.js";
import { findStoreRoot, loadConfig, requireStoreRoot } from "./config.js";
import { loadStore, writeNodeFile } from "./files.js";
import { CURRENT_TURN_FILE, currentTurn } from "./ops.js";
import { writeText } from "../util.js";

export interface WorkingStore {
  /** Directory every command operates on: the store itself, or the caller's branch worktree inside another store. */
  root: string;
  /** The store the session runs in (cwd inside it), when any. */
  caller: string | null;
  /** True when the command targets a store other than the caller's: memory is imprinted there, never in the caller. */
  cross: boolean;
  branch: string | null;
  mirrored_turn: string | null;
}

function same(a: string, b: string): boolean {
  const r = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return r(a) === r(b);
}

/**
 * Mirror the caller's current session and turn into the target store so that records written there carry a
 * `caused_by` that resolves locally: the child knows which parent prompt caused the write.
 */
export function mirrorTurn(callerRoot: string, targetRoot: string): string | null {
  const turnId = currentTurn(callerRoot);
  if (!turnId) return null;
  const caller = loadStore(callerRoot);
  const turn = caller.nodes.get(turnId);
  if (!turn || turn.type !== "turn") return null;
  const target = loadStore(targetRoot);
  const session = caller.nodes.get(turn.session);
  if (session && session.type === "session" && !target.nodes.has(session.id)) {
    writeNodeFile(targetRoot, { ...session, title: `${session.title} (mirrored from store ${caller.config.id})` }, "");
  }
  if (!target.nodes.has(turnId)) writeNodeFile(targetRoot, { ...turn }, caller.bodies.get(turnId) ?? "");
  writeText(join(targetRoot, CURRENT_TURN_FILE), `${turnId}\n`);
  return turnId;
}

/**
 * Where a command works. From outside any store, `--store` (or cwd) is used as is. From inside a store, targeting a
 * different store means the gap belongs to that store: the command runs in that store's `parent/<caller-id>` worktree,
 * the caller's turn is mirrored there, and records are attributed to the caller's agent. `onMain` bypasses this for
 * reconciliation and tooling.
 */
export function resolveWorkingStore(storeOpt: string | undefined, cwd: string, opts: { onMain?: boolean } = {}): WorkingStore {
  const target = requireStoreRoot(resolve(storeOpt ?? cwd));
  const caller = findStoreRoot(cwd);
  if (!storeOpt || !caller || same(caller, target) || opts.onMain) {
    return { root: target, caller, cross: false, branch: null, mirrored_turn: null };
  }
  if (!existsSync(join(target, ".git"))) {
    // Without git there is no branch to isolate the caller's writes; still write in the target, never in the caller.
    const mirrored = mirrorTurn(caller, target);
    process.env["WHITESNAKE_ACTOR"] ??= `agent:${loadConfig(caller).id}`;
    return { root: target, caller, cross: true, branch: null, mirrored_turn: mirrored };
  }
  const callerId = loadConfig(caller).id;
  const open = openParentBranch(target, callerId);
  const mirrored = mirrorTurn(caller, open.worktree);
  process.env["WHITESNAKE_ACTOR"] ??= `agent:${callerId}`;
  return { root: open.worktree, caller, cross: true, branch: open.branch, mirrored_turn: mirrored };
}
