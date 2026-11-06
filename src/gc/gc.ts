import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "../schema/ids.js";
import type { Episode, Evidence, Node, Procedure, Template } from "../schema/nodes.js";
import { loadStore, nodePath, writeNodeFile, type LoadedStore } from "../store/files.js";
import { recordDelete } from "../store/journal.js";
import { updateNode } from "../store/ops.js";
import { errorsOf, validateStore } from "../store/validate.js";
import { CliError, collapseWs, nowIso, truncate } from "../util.js";

/**
 * Garbage collection as compaction. Live roots are the records a reader may still rely on: decisions that are not
 * superseded or retired, procedures still in use (not retired or superseded), questions, sessions, turns, artifacts,
 * templates, and every episode that produced or promoted something live, or that is the parent of a live episode.
 * A closed, cold episode subtree that nothing live needs is compacted into a `template` node (summary, locators,
 * negative examples, the ids it replaces, the commit that still holds the raw files) and swept from the working tree.
 * The code of a superseded or retired procedure is archived the same way once it is cold: the record stays, with the
 * commit that holds the code, because every result it produced still points at it. Git history keeps the raw.
 */
export interface SweepItem {
  id: string;
  type: string;
  title: string;
  reason: string;
}

export interface CodeArchiveItem {
  id: string;
  entrypoint: string;
  /** Paths removed from the working tree: the entrypoint's directory when no other procedure lives there, else the file. */
  remove: string[];
  reason: string;
}

export interface GcPlan {
  cold_after_sessions: number;
  sessions: number;
  live: number;
  sweep: SweepItem[];
  templates: { title: string; ids: string[]; negative_examples: number }[];
  code_archive: CodeArchiveItem[];
}

/** Evidence a record still cites: a decision's data, backing or rebuttal, or a procedure's justification. */
function citedByRecord(nodes: Map<string, Node>, evidenceId: string): boolean {
  for (const d of nodes.values()) {
    if (d.type === "decision" && (d.data.includes(evidenceId) || d.backing.includes(evidenceId) || d.rebuttal.evidence.includes(evidenceId))) return true;
    if (d.type === "procedure" && d.justification?.evidence.includes(evidenceId)) return true;
  }
  return false;
}

function sessionOrder(store: LoadedStore): Map<string, number> {
  const sessions = [...store.nodes.values()].filter((n): n is Node & { type: "session" } => n.type === "session").sort((a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id));
  return new Map(sessions.map((s, i) => [s.id, i]));
}

function sessionOfTurn(store: LoadedStore, turn: string | null): string | null {
  if (!turn) return null;
  const t = store.nodes.get(turn);
  // A procedure's history may cite the choice decision of an explicit transition instead of a turn.
  if (t && t.type === "decision") return sessionOfTurn(store, t.caused_by);
  return t && t.type === "turn" ? t.session : null;
}

export function planGc(store: LoadedStore, opts: { coldAfter?: number } = {}): GcPlan {
  const coldAfter = opts.coldAfter ?? store.config.gc.cold_after_sessions;
  const order = sessionOrder(store);
  const latest = order.size - 1;
  const nodes = store.nodes;

  const episodes = [...nodes.values()].filter((n): n is Episode => n.type === "episode");
  const needed = new Set<string>();
  for (const n of nodes.values()) {
    if (n.type === "decision" && n.status !== "superseded" && n.status !== "retired" && n.produced_by) needed.add(n.produced_by);
    if (n.type === "procedure" && n.state !== "retired" && n.state !== "superseded") {
      for (const e of n.promoted_from) needed.add(e);
      if (n.produced_by) needed.add(n.produced_by);
    }
    if (n.type === "question" && n.status === "open" && n.raised_in) needed.add(n.raised_in);
    if (n.type === "evidence" && n.produced_by && citedByRecord(nodes, n.id)) {
      // cited evidence keeps its episode
      needed.add(n.produced_by);
    }
  }

  const isCold = (e: Episode): boolean => {
    if (e.outcome === "open") return false;
    const s = sessionOfTurn(store, e.caused_by);
    if (s === null) return e.ended !== null;
    const idx = order.get(s);
    return idx !== undefined && latest - idx >= coldAfter;
  };
  const byParent = new Map<string | null, Episode[]>();
  for (const e of episodes) {
    const list = byParent.get(e.parent) ?? [];
    list.push(e);
    byParent.set(e.parent, list);
  }
  const subtree = (e: Episode): Episode[] => [e, ...(byParent.get(e.id) ?? []).flatMap(subtree)];
  const sweepable = (e: Episode): boolean => isCold(e) && !needed.has(e.id);

  const sweep: SweepItem[] = [];
  const templates: GcPlan["templates"] = [];
  const swept = new Set<string>();
  for (const rootEp of byParent.get(null) ?? []) {
    const tree = subtree(rootEp);
    if (!tree.every(sweepable)) continue;
    const ids: string[] = [];
    let negatives = 0;
    for (const e of tree) {
      ids.push(e.id);
      swept.add(e.id);
      sweep.push({ id: e.id, type: "episode", title: e.title, reason: `cold ${e.outcome} episode, nothing live depends on it` });
      if (e.outcome === "failure" || e.outcome === "abstained") negatives++;
    }
    // Evidence produced inside this subtree and cited by nothing live; each record is swept once, even when
    // several subtrees are compacted in the same run.
    const treeIds = new Set(tree.map((e) => e.id));
    for (const n of nodes.values()) {
      if (n.type !== "evidence" || !n.produced_by || !treeIds.has(n.produced_by) || swept.has(n.id)) continue;
      if (citedByRecord(nodes, n.id)) continue;
      ids.push(n.id);
      swept.add(n.id);
      sweep.push({ id: n.id, type: "evidence", title: n.title, reason: "produced inside a swept subtree and cited by nothing live" });
    }
    templates.push({ title: `Compacted: ${rootEp.title}`, ids, negative_examples: negatives });
  }

  // Code of superseded or retired procedures: cold when the transition is old enough, archived with its commit.
  const isFile = (rel: string) => {
    const abs = join(store.root, rel);
    return existsSync(abs) && statSync(abs).isFile();
  };
  const archivable = [...nodes.values()].filter((n): n is Procedure => n.type === "procedure" && (n.state === "superseded" || n.state === "retired") && n.code_hash !== null && n.code_archived === null && isFile(n.entrypoint));
  const coldProcedure = (p: Procedure): boolean => {
    const last = p.history[p.history.length - 1];
    const s = sessionOfTurn(store, last?.caused_by ?? null);
    if (s === null) return true;
    const idx = order.get(s);
    return idx !== undefined && latest - idx >= coldAfter;
  };
  const candidates = archivable.filter(coldProcedure);
  const candidateIds = new Set(candidates.map((p) => p.id));
  const code_archive: CodeArchiveItem[] = candidates.map((p) => {
    const dir = dirname(p.entrypoint);
    const under = (f: string) => f === dir || f.startsWith(`${dir}/`);
    const sharers = [...nodes.values()].filter((n): n is Procedure => n.type === "procedure" && n.id !== p.id && !candidateIds.has(n.id) && [n.entrypoint, ...n.regression_cases].some(under));
    const wholeDir = dir !== "." && dir !== "" && dir !== "procedures" && sharers.length === 0;
    return { id: p.id, entrypoint: p.entrypoint, remove: [wholeDir ? dir : p.entrypoint], reason: `${p.state} procedure whose code is cold; the record stays and git keeps the code` };
  });
  return { cold_after_sessions: coldAfter, sessions: order.size, live: nodes.size - swept.size, sweep, templates, code_archive };
}

function headCommit(root: string): string {
  if (!existsSync(join(root, ".git"))) return "";
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

export interface GcResult {
  swept: number;
  templates: string[];
  /** Procedures whose code left the working tree in this run. */
  code_archived: string[];
  commit: string | null;
}

export function applyGc(root: string, plan: GcPlan): GcResult {
  const store = loadStore(root);
  if (!plan.sweep.length && !plan.code_archive.length) return { swept: 0, templates: [], code_archived: [], commit: null };
  if (!existsSync(join(root, ".git"))) {
    throw new CliError("gc --apply needs a git repository: the raw records of a compacted subtree survive only in git history. Put the store under git and commit it first, or use the plan without --apply.", 1);
  }
  // Everything about to be swept must already be in history: commit the working tree first, so the commit recorded
  // in the template contains every raw record it replaces, by construction.
  if (spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim()) {
    try {
      execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "store: before gc"], { stdio: "ignore" });
    } catch (e) {
      throw new CliError(`gc --apply could not commit the working tree before compacting (${(e as Error).message.split("\n")[0] ?? ""}); nothing was changed`, 1);
    }
  }
  const commit = headCommit(root);
  if (!commit) throw new CliError("gc --apply could not read the git HEAD; commit the store first", 1);
  const created: string[] = [];
  for (const t of plan.templates) {
    const members = t.ids.map((id) => store.nodes.get(id)).filter((n): n is Node => !!n);
    const episodes = members.filter((n): n is Episode => n.type === "episode");
    const evidence = members.filter((n): n is Evidence => n.type === "evidence");
    const summary = episodes
      .map((e) => `${e.id} ${e.title}: ${e.outcome}, ${e.resolution}${e.uses.length ? `, used ${e.uses.join(", ")}` : ""}${store.bodies.get(e.id) ? ` — ${truncate(collapseWs(store.bodies.get(e.id) ?? ""), 200)}` : ""}`)
      .join("\n");
    const template: Template = {
      id: newId("template"),
      title: t.title,
      created: nowIso(),
      created_by: "gc",
      type: "template",
      compacted_from: { count: t.ids.length, commit, ids: [...t.ids].sort() },
      summary,
      locators: evidence.map((e) => ({ evidence: e.id, locator: e.locator, excerpt: truncate(collapseWs(store.bodies.get(e.id) ?? ""), 160) })),
      negative_examples: episodes.filter((e) => e.outcome === "failure" || e.outcome === "abstained").map((e) => `${e.title}: ${truncate(collapseWs(store.bodies.get(e.id) ?? ""), 300)}`),
      caused_by: null,
    };
    writeNodeFile(root, template, `Compacted by gc on ${template.created}. Raw records are in git history at commit ${commit || "(no git)"}.`);
    created.push(template.id);
  }
  for (const item of plan.sweep) {
    const n = store.nodes.get(item.id);
    if (!n) continue;
    const swept = nodePath(root, n.type, n.id);
    rmSync(swept, { force: true });
    recordDelete(root, swept);
  }
  // The record is updated before its code goes: it must say where the code lives before the file is missing.
  const archived: string[] = [];
  for (const item of plan.code_archive) {
    updateNode(root, item.id, { code_archived: { commit, at: nowIso(), removed: item.remove } }, undefined, { store });
    for (const rel of item.remove) rmSync(join(root, rel), { recursive: true, force: true });
    archived.push(item.id);
  }
  const after = loadStore(root);
  const errors = errorsOf(validateStore(after));
  if (errors.length) {
    // Never leave an invalid store: restore from git when possible.
    if (commit) {
      execFileSync("git", ["-C", root, "checkout", "--", "."], { stdio: "ignore" });
      for (const id of created) {
        rmSync(nodePath(root, "template", id), { force: true });
        recordDelete(root, nodePath(root, "template", id));
      }
    }
    throw new CliError(`gc would leave the store invalid (${errors.map((e) => e.code).join(", ")}); nothing was changed`, 2, errors);
  }
  let newCommit: string | null = null;
  if (commit) {
    execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "-m", `store: gc compacted ${plan.sweep.length} records into ${created.length} template(s)${archived.length ? `, archived the code of ${archived.length} procedure(s)` : ""}`], { stdio: "ignore" });
    newCommit = headCommit(root);
  }
  return { swept: plan.sweep.length, templates: created, code_archived: archived, commit: newCommit };
}
