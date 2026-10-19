import { existsSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_SUFFIX, edgeSpec, extractEdges } from "../schema/edges.js";
import type { NodeType } from "../schema/ids.js";
import { canonicalBody, sha256 } from "../util.js";
import type { LoadedStore, ValidationIssue } from "./files.js";

/** Graph-level checks on top of the file-level issues collected by loadStore. */
export function errorsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity !== "warning");
}

export function warningsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === "warning");
}

export function validateStore(store: LoadedStore): ValidationIssue[] {
  const issues: ValidationIssue[] = [...store.issues];
  const ids = [...store.nodes.keys()].sort();

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
        break;
      }
      case "evidence": {
        const body = store.bodies.get(id) ?? "";
        if (sha256(canonicalBody(body)) !== node.hash) {
          issues.push({ code: "E_HASH_MISMATCH", id, file, path: "hash", message: `${id}.hash does not match sha256 of the excerpt body` });
        }
        break;
      }
      case "artifact":
        if (!existsSync(join(store.root, node.path))) {
          issues.push({ code: "E_ARTIFACT_MISSING", id, file, path: "path", message: `${id} refers to ${node.path}, which does not exist` });
        }
        break;
      case "procedure": {
        const last = node.history[node.history.length - 1];
        if (last && last.to !== node.state) {
          issues.push({ code: "E_STATE_MISMATCH", id, file, path: "state", message: `${id}.state is ${node.state} but the last history entry says ${last.to}` });
        }
        break;
      }
      default:
        break;
    }
  }

  issues.push(...cycleIssues(store));

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
  { type: "procedure", rels: ["uses"] },
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
