import { ensureIndex } from "../index/db.js";
import { affected } from "../index/queries.js";
import type { Decision } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode, updateNode } from "../store/ops.js";
import { CliError, nowIso } from "../util.js";
import { recordCorrection } from "./procedures.js";

export interface CorrectionResult {
  decision: string;
  replacement: string | null;
  needs_review: string[];
  suspended: string[];
  episode: string | null;
}

/**
 * The researcher said a result is wrong. Nothing is deleted: the decision is marked (or superseded when a value
 * is given), the episode that produced it is marked corrected, the procedures it used are suspended, and every
 * decision that transitively relied on it is marked needs_review.
 */
export function correctDecision(store: LoadedStore, decisionId: string, reason: string, turn: string | null, opts: { value?: unknown; actor?: string } = {}): CorrectionResult {
  const d = store.nodes.get(decisionId);
  if (!d || d.type !== "decision") throw new CliError(`${decisionId} is not a decision`, 1);

  // Dependents are computed before anything changes.
  const db = ensureIndex(store.root);
  const dependents = affected(db, decisionId).filter((r) => r.type === "decision");
  db.close();

  const body = `${store.bodies.get(decisionId) ?? ""}\n\nCorrection (${turn ?? "no turn"}, ${nowIso()}): ${reason}`.trim();
  let replacement: string | null = null;
  if (opts.value !== undefined) {
    if (!d.target) throw new CliError("--value applies only to annotation decisions with a target", 1);
    const rep = createNode(
      store.root,
      "decision",
      {
        title: d.title,
        kind: d.kind,
        status: "active",
        claim: `Corrected by the researcher: ${d.target.field} = ${JSON.stringify(opts.value)} (was ${JSON.stringify(d.target.value)})`,
        qualifier: { confidence: 1, scope: `${d.qualifier.scope}; researcher correction` },
        fragility: d.fragility,
        target: { ...d.target, value: opts.value as string | number | boolean | null },
        data: d.data,
        warrant: d.warrant,
        backing: d.backing,
        rebuttal: { text: "", evidence: [] },
        depends_on: d.depends_on,
        supersedes: [d.id],
        answers: d.answers,
        produced_by: null,
        shown_at: turn ? [turn] : [],
      },
      reason,
      { store, causedBy: turn, actor: opts.actor ?? "human:researcher" },
    );
    replacement = rep.id;
    updateNode(store.root, decisionId, { status: "superseded" }, body, { store });
  } else {
    updateNode(store.root, decisionId, { status: "needs_review" }, body, { store });
  }

  const suspended: string[] = [];
  if (d.produced_by) {
    const ep = store.nodes.get(d.produced_by);
    if (ep && ep.type === "episode") {
      updateNode(store.root, ep.id, { outcome: "corrected" }, undefined, { store });
      for (const used of ep.uses) {
        const u = store.nodes.get(used);
        if (u && u.type === "procedure" && u.state !== "suspended" && u.state !== "retired") {
          recordCorrection(store, used, reason, turn);
          suspended.push(used);
        }
      }
    }
  }

  const needsReview: string[] = [];
  for (const dep of dependents) {
    const n = store.nodes.get(dep.id) as Decision | undefined;
    if (!n || n.type !== "decision") continue;
    if (n.status === "active" || n.status === "proposed") {
      updateNode(store.root, n.id, { status: "needs_review" }, undefined, { store });
      needsReview.push(n.id);
    }
  }
  return { decision: decisionId, replacement, needs_review: needsReview.sort(), suspended: suspended.sort(), episode: d.produced_by };
}
