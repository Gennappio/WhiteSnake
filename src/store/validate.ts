import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchContext, collectEvents, replay, stateSequence, type DeriveContext } from "../lifecycle/derive.js";
import { REMOTE_SUFFIX, edgeSpec, extractEdges } from "../schema/edges.js";
import type { NodeType } from "../schema/ids.js";
import { canonicalBody, sha256 } from "../util.js";
import { artifactIssues, type ArtifactCheckMode } from "./artifacts.js";
import type { Node } from "../schema/nodes.js";
import type { LoadedStore, ValidationIssue } from "./files.js";

/** Graph-level checks on top of the file-level issues collected by loadStore. */
export function errorsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity !== "warning");
}

export function warningsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === "warning");
}

export interface ValidateOptions {
  /** How artifact files are compared with their registered sha256: trust a size/mtime cache, re-read every file, or skip. */
  artifacts?: ArtifactCheckMode | "skip";
  /** Branch context the procedure caches are derived in; the store directory's own branch when omitted. */
  context?: DeriveContext;
}

export function validateStore(store: LoadedStore, opts: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [...store.issues];
  const ids = [...store.nodes.keys()].sort();
  // Procedure caches are checked against a replay of the recorded events, in the branch context of this directory.
  const events = collectEvents(store, opts.context ?? branchContext(store.root));
  const threshold = store.config.promotion.shown_uses_to_trust;
  const successors = successorsPerProcedure(store);

  for (const id of ids) {
    const node = store.nodes.get(id)!;
    const file = store.paths.get(id);

    for (const edge of extractEdges(node)) {
      if (edge.rel.endsWith(REMOTE_SUFFIX)) continue;
      const target = store.nodes.get(edge.dst);
      if (!target) {
        issues.push({ code: "E_DANGLING_EDGE", id, file, path: edge.rel, message: `${id}.${edge.rel} points to missing node ${edge.dst}` });
        continue;
      }
      const spec = edgeSpec(node.type, edge.rel);
      if (spec && spec.targets !== "any" && !spec.targets.includes(target.type)) {
        issues.push({
          code: "E_WRONG_TARGET_TYPE",
          id,
          file,
          path: edge.rel,
          message: `${id}.${edge.rel} must point to ${spec.targets.join("|")}, found ${target.type} ${edge.dst}`,
        });
      }
    }

    switch (node.type) {
      case "decision": {
        if (node.produced_by) {
          const ep = store.nodes.get(node.produced_by);
          if (ep && ep.type === "episode") {
            if (ep.children.length > 0) {
              issues.push({ severity: "warning", code: "W_COARSE_EPISODE", id, file, path: "produced_by", message: `${id} is produced by ${ep.id}, which has child episodes; produce decisions from leaf episodes so a change propagates only where it applies` });
            }
            const declared = new Set([...node.warrant, ...node.backing, ...node.depends_on]);
            const uncited = ep.uses.filter((u) => {
              const t = store.nodes.get(u);
              return t && t.type === "decision" && !declared.has(u);
            });
            if (uncited.length) {
              issues.push({ severity: "warning", code: "W_UNCITED_CRITERION", id, file, path: "warrant", message: `episode ${ep.id} uses ${uncited.join(", ")} but ${id} does not cite them in warrant, backing or depends_on; either cite them or move them to the episode that applied them` });
            }
          }
        }
        for (const w of node.warrant) {
          const t = store.nodes.get(w);
          if (t && t.type === "decision" && t.kind !== "criterion") {
            issues.push({ code: "E_WARRANT_NOT_CRITERION", id, file, path: "warrant", message: `${id}.warrant ${w} is a ${t.kind} decision, not a criterion` });
          }
        }
        if (node.transition && !node.depends_on.includes(node.transition.procedure)) {
          issues.push({ code: "E_TRANSITION_DEPENDS_ON", id, file, path: "transition", message: `${id} records a transition of ${node.transition.procedure} but does not list it in depends_on` });
        }
        break;
      }
      case "evidence": {
        const body = store.bodies.get(id) ?? "";
        if (sha256(canonicalBody(body)) !== node.hash) {
          issues.push({ code: "E_HASH_MISMATCH", id, file, path: "hash", message: `${id}.hash does not match sha256 of the excerpt body` });
        }
        break;
      }
      case "procedure": {
        const derived = replay(node, events.get(id) ?? [], threshold);
        const repair = `state, counters and history are a cache of the recorded events; run \`whitesnake procedure recompute ${id}\``;
        if (node.state !== derived.state) {
          issues.push({ code: "E_STATE_MISMATCH", id, file, path: "state", message: `${id}.state is ${node.state} but the recorded events derive ${derived.state}; ${repair}` });
        }
        if (node.counters.shown_uses !== derived.counters.shown_uses || node.counters.corrections !== derived.counters.corrections) {
          issues.push({ code: "E_COUNTER_MISMATCH", id, file, path: "counters", message: `${id}.counters are ${node.counters.shown_uses} shown use(s) and ${node.counters.corrections} correction(s) but the recorded events derive ${derived.counters.shown_uses} and ${derived.counters.corrections}; ${repair}` });
        }
        if (stateSequence(node.history) !== stateSequence(derived.history)) {
          issues.push({ code: "E_HISTORY_MISMATCH", id, file, path: "history", message: `${id}.history reads ${stateSequence(node.history) || "(empty)"} but the recorded events derive ${stateSequence(derived.history)}; ${repair}` });
        }
        for (const w of derived.warnings) {
          issues.push({ severity: "warning", code: "W_TRANSITION_IGNORED", id: w.decision, file: store.paths.get(w.decision), path: "transition", message: w.message });
        }
        issues.push(...codeHashIssues(store, node, file));
        if (node.supersedes.length > 0 && (!node.justification || node.justification.evidence.length === 0)) {
          issues.push({ code: "E_UNJUSTIFIED_SUPERSESSION", id, file, path: "justification", message: `${id} supersedes ${node.supersedes.join(", ")} without a justification that cites evidence; state the kind (correctness, performance, scope, platform) and the records that prove it` });
        }
        if (node.state === "superseded" && !(successors.get(id)?.length)) {
          issues.push({ code: "E_SUPERSEDED_NO_SUCCESSOR", id, file, path: "state", message: `${id} is superseded but no procedure lists it in supersedes; the state is derived from a recorded supersession` });
        }
        break;
      }
      default:
        break;
    }
  }

  issues.push(...duplicateActiveIssues(store));
  issues.push(...cycleIssues(store));
  if (opts.artifacts !== "skip") issues.push(...artifactIssues(store, opts.artifacts ?? "cached"));

  for (const i of issues) if (!i.severity) i.severity = "error";
  return issues.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code) || (a.path ?? "").localeCompare(b.path ?? ""));
}

/**
 * Relations along which a node rests on, replaces or nests inside another node of the same type. The knowledge
 * graph is a DAG by design (DESIGN.md B.7): a cycle here is circular reasoning, and `affected`, `why`, `gc` and
 * `collapse` would follow it. Inverse pairs such as parent/children are checked one direction at a time.
 */
const ACYCLIC_FAMILIES: readonly { type: NodeType; rels: readonly string[] }[] = [
  { type: "decision", rels: ["depends_on", "warrant", "backing", "supersedes"] },
  { type: "procedure", rels: ["uses", "supersedes"] },
  { type: "episode", rels: ["parent"] },
  { type: "episode", rels: ["children"] },
];

function cycleIssues(store: LoadedStore): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const reported = new Set<string>();
  for (const family of ACYCLIC_FAMILIES) {
    const adjacency = new Map<string, { dst: string; rel: string }[]>();
    for (const [id, node] of store.nodes) {
      if (node.type !== family.type) continue;
      adjacency.set(
        id,
        extractEdges(node)
          .filter((e) => family.rels.includes(e.rel) && store.nodes.get(e.dst)?.type === family.type)
          .map((e) => ({ dst: e.dst, rel: e.rel })),
      );
    }
    for (const cycle of findCycles(adjacency)) {
      const key = `${family.rels.join("/")}:${cycle.path.join(">")}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const chain = cycle.path.join(" -> ");
      for (const id of new Set(cycle.path)) {
        out.push({
          code: "E_CYCLE",
          id,
          file: store.paths.get(id),
          path: cycle.rel,
          message: `${family.rels.join("/")} edges between ${family.type} nodes form a cycle (${chain}); a record cannot rest on, replace or contain itself`,
        });
      }
    }
  }
  return out;
}

/** Iterative depth-first search; every back edge yields the cycle it closes, from the revisited node round to itself. */
function findCycles(adjacency: Map<string, { dst: string; rel: string }[]>): { path: string[]; rel: string }[] {
  const found: { path: string[]; rel: string }[] = [];
  const state = new Map<string, "open" | "done">();
  for (const root of [...adjacency.keys()].sort()) {
    if (state.has(root)) continue;
    const path: string[] = [root];
    const frames: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, "open");
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const edges = adjacency.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        frames.pop();
        path.pop();
        state.set(frame.id, "done");
        continue;
      }
      const edge = edges[frame.next++]!;
      const s = state.get(edge.dst);
      if (s === undefined) {
        state.set(edge.dst, "open");
        path.push(edge.dst);
        frames.push({ id: edge.dst, next: 0 });
      } else if (s === "open") {
        found.push({ path: [...path.slice(path.indexOf(edge.dst)), edge.dst], rel: edge.rel });
      }
    }
  }
  return found;
}

/**
 * The code behind a procedure is verified by content, like a source artifact: the record keeps the sha256 of the
 * entrypoint at registration, and a file that differs means past executions point at code that is no longer there.
 * A procedure whose code gc archived (git keeps it at the recorded commit) may legitimately have no file.
 */
function codeHashIssues(store: LoadedStore, node: Extract<Node, { type: "procedure" }>, file: string | undefined): ValidationIssue[] {
  if (!node.code_hash) return [];
  const abs = join(store.root, node.entrypoint);
  const present = existsSync(abs) && statSync(abs).isFile();
  if (!present) {
    if (node.code_archived) return [];
    return [{ code: "E_PROCEDURE_HASH", id: node.id, file, path: "entrypoint", message: `${node.id}: ${node.entrypoint} is missing but the procedure's code was registered with sha256 ${node.code_hash.slice(0, 12)}…; restore it from git, or let gc archive it` }];
  }
  const actual = sha256(readFileSync(abs));
  if (actual === node.code_hash) return [];
  return [
    {
      code: "E_PROCEDURE_HASH",
      id: node.id,
      file,
      path: "code_hash",
      message: `${node.id}: ${node.entrypoint} has sha256 ${actual.slice(0, 12)}… on disk but ${node.code_hash.slice(0, 12)}… was registered. Code that produced results never changes: restore the file, or register the new version as a new procedure that supersedes ${node.id} (whitesnake procedure rehash is allowed only while nothing used it).`,
    },
  ];
}

/**
 * One active annotation per cell. The resolution ladder, `export-output` and a correction all read "the" active value
 * of a cell; two of them would make the newest win in silence. A replacement supersedes what it replaces in the same step.
 */
function duplicateActiveIssues(store: LoadedStore): ValidationIssue[] {
  const byCell = new Map<string, string[]>();
  for (const n of store.nodes.values()) {
    if (n.type !== "decision" || n.kind !== "annotation" || n.status !== "active" || !n.target) continue;
    const key = `${n.target.unit}\u0000${n.target.field}`;
    byCell.set(key, [...(byCell.get(key) ?? []), n.id]);
  }
  const out: ValidationIssue[] = [];
  for (const [key, ids] of byCell) {
    if (ids.length < 2) continue;
    const [unit, field] = key.split("\u0000");
    for (const id of [...ids].sort()) {
      out.push({ code: "E_DUPLICATE_ACTIVE", id, file: store.paths.get(id), path: "status", message: `${id} is active for ${unit}/${field} together with ${ids.filter((x) => x !== id).join(", ")}; a cell holds one active annotation: the one that no longer holds must be superseded` });
    }
  }
  return out;
}

/** Procedures that list each procedure in `supersedes`. */
function successorsPerProcedure(store: LoadedStore): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of store.nodes.values()) {
    if (n.type !== "procedure") continue;
    for (const old of n.supersedes) out.set(old, [...(out.get(old) ?? []), n.id]);
  }
  return out;
}

