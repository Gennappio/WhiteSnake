import type { NodeType } from "./ids.js";
import type { Node } from "./nodes.js";

/**
 * Canonical edge directions. Each spec names a frontmatter field (path) on the source node type,
 * the node types it may point to, and whether the edge means "source relies on target"
 * (used by `affected` and by garbage-collection marking).
 */
export interface EdgeSpec {
  rel: string;
  path: readonly string[];
  targets: readonly NodeType[] | "any";
  relies: boolean;
}

const turn = (path = "caused_by"): EdgeSpec => ({ rel: path, path: [path], targets: ["turn"], relies: false });

export const EDGE_SPECS: Record<NodeType, readonly EdgeSpec[]> = {
  question: [
    { rel: "raised_in", path: ["raised_in"], targets: ["episode"], relies: false },
    { rel: "answered_by", path: ["answered_by"], targets: ["decision"], relies: false },
    turn(),
  ],
  decision: [
    { rel: "data", path: ["data"], targets: ["evidence"], relies: true },
    { rel: "warrant", path: ["warrant"], targets: ["decision"], relies: true },
    { rel: "backing", path: ["backing"], targets: ["evidence", "decision"], relies: true },
    { rel: "rebuttal", path: ["rebuttal", "evidence"], targets: ["evidence"], relies: true },
    { rel: "depends_on", path: ["depends_on"], targets: ["decision", "procedure"], relies: true },
    { rel: "supersedes", path: ["supersedes"], targets: ["decision"], relies: false },
    { rel: "answers", path: ["answers"], targets: ["question"], relies: false },
    { rel: "produced_by", path: ["produced_by"], targets: ["episode"], relies: true },
    turn(),
    { rel: "shown_at", path: ["shown_at"], targets: ["turn"], relies: false },
  ],
  evidence: [
    { rel: "locator", path: ["locator", "artifact"], targets: ["artifact"], relies: true },
    { rel: "produced_by", path: ["produced_by"], targets: ["episode"], relies: false },
    turn(),
  ],
  artifact: [turn()],
  procedure: [
    { rel: "uses", path: ["uses"], targets: ["procedure", "decision"], relies: true },
    { rel: "promoted_from", path: ["promoted_from"], targets: ["episode"], relies: false },
    { rel: "produced_by", path: ["produced_by"], targets: ["episode"], relies: false },
    turn(),
  ],
  episode: [
    { rel: "question", path: ["question"], targets: ["question"], relies: false },
    { rel: "parent", path: ["parent"], targets: ["episode"], relies: false },
    { rel: "uses", path: ["uses"], targets: ["procedure", "decision"], relies: true },
    { rel: "produces", path: ["produces"], targets: ["decision", "evidence", "artifact", "question", "procedure"], relies: false },
    { rel: "children", path: ["children"], targets: ["episode"], relies: false },
    turn(),
  ],
  session: [],
  turn: [{ rel: "session", path: ["session"], targets: ["session"], relies: false }],
  template: [turn()],
};

export const RELIES_RELS: readonly string[] = [
  ...new Set(
    Object.values(EDGE_SPECS)
      .flat()
      .filter((s) => s.relies)
      .map((s) => s.rel),
  ),
];

export interface Edge {
  rel: string;
  dst: string;
}

/** Suffix used for references to nodes living in another store (never validated locally). */
export const REMOTE_SUFFIX = "_remote";

export function extractEdges(node: Node): Edge[] {
  const out: Edge[] = [];
  for (const spec of EDGE_SPECS[node.type]) {
    let value: unknown = node;
    for (const key of spec.path) {
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (value === null || value === undefined) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === "string") out.push({ rel: spec.rel, dst: item });
      else if (item && typeof item === "object" && "store" in item && "id" in item) {
        const r = item as { store: string; id: string };
        out.push({ rel: `${spec.rel}${REMOTE_SUFFIX}`, dst: `${r.store}:${r.id}` });
      }
    }
  }
  return out;
}

export function edgeSpec(type: NodeType, rel: string): EdgeSpec | undefined {
  return EDGE_SPECS[type].find((s) => s.rel === rel);
}
