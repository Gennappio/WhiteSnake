import { existsSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_SUFFIX, edgeSpec, extractEdges } from "../schema/edges.js";
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

  for (const i of issues) if (!i.severity) i.severity = "error";
  return issues.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.code.localeCompare(b.code) || (a.path ?? "").localeCompare(b.path ?? ""));
}
