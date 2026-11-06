import { ensureIndex } from "../index/db.js";
import { affected } from "../index/queries.js";
import type { Decision, RemoteRef } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode, updateNode } from "../store/ops.js";
import { CliError, nowIso, sha256 } from "../util.js";
import { branchContext, ownerFor } from "./derive.js";
import { correctedEventId, enqueue, remoteDecisionTargets, turnInfo, type OutboxEvent } from "./outbox.js";
import { recomputeProcedureCache } from "./procedures.js";

export interface CorrectionResult {
  decision: string;
  replacement: string | null;
  needs_review: string[];
  suspended: string[];
  episode: string | null;
  /** Identifier of this correction as an event: the same event is never applied twice. */
  event: string;
  /** True when the event had already been applied: nothing was written, the previous outcome is reported. */
  already: boolean;
  /** Corrections queued for the records of other stores this decision rests on; `sync` delivers them. */
  remote: { event: string; target: RemoteRef }[];
}

export interface CorrectOptions {
  value?: unknown;
  actor?: string;
  /** Event id; derived from the decision and the turn when omitted. */
  event?: string;
  /** Moment of the correction; now when omitted. */
  at?: string;
}

/**
 * The researcher said a result is wrong. Nothing is deleted: the decision records the correction as an event and is
 * marked (or superseded when a value is given), the episode that produced it is marked corrected, the procedures it
 * used derive their suspension from the event, and every decision that transitively relied on it is marked needs_review.
 */
export function correctDecision(store: LoadedStore, decisionId: string, reason: string, turn: string | null, opts: CorrectOptions = {}): CorrectionResult {
  const d = store.nodes.get(decisionId);
  if (!d || d.type !== "decision") throw new CliError(`${decisionId} is not a decision`, 1);
  const at = opts.at ?? nowIso();
  // The researcher of this context: the store's own on main, the parent's on its branch (DESIGN K.47).
  const actor = opts.actor ?? ownerFor(branchContext(store.root).branch);
  if (!turn && !opts.event) throw new CliError(`correcting ${decisionId} without a current turn needs --event <id>, so that the same correction is recognised when it comes again`, 1);
  const event = opts.event ?? sha256(`${decisionId}:${turn}`);
  if (d.corrections.some((c) => c.event === event)) {
    const replacement = [...store.nodes.values()].find((n): n is Decision => n.type === "decision" && n.supersedes.includes(decisionId)) ?? null;
    return { decision: decisionId, replacement: replacement?.id ?? null, needs_review: [], suspended: [], episode: d.produced_by, event, already: true, remote: [] };
  }
  if (d.status === "superseded" || d.status === "retired") {
    const successor = [...store.nodes.values()].find((n): n is Decision => n.type === "decision" && n.supersedes.includes(decisionId));
    throw new CliError(`${decisionId} is ${d.status}${successor ? ` by ${successor.id}` : ""}; correct the decision that currently holds the value`, 2);
  }

  // Dependents are computed before anything changes.
  const db = ensureIndex(store.root);
  const dependents = affected(db, decisionId).filter((r) => r.type === "decision");
  db.close();

  const body = `${store.bodies.get(decisionId) ?? ""}\n\nCorrection (${turn ?? "no turn"}, ${at}): ${reason}`.trim();
  const corrections = [...d.corrections, { turn, at, reason, event, actor }];
  let replacement: string | null = null;
  if (opts.value !== undefined) {
    if (!d.target) throw new CliError("--value applies only to annotation decisions with a target", 1);
    // The old decision leaves the cell before the replacement takes it: one active annotation per cell at every step.
    updateNode(store.root, decisionId, { status: "superseded", corrections }, body, { store });
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
        shown_at: turn ? [{ turn, at }] : [],
      },
      reason,
      { store, causedBy: turn, actor },
    );
    replacement = rep.id;
  } else {
    updateNode(store.root, decisionId, { status: "needs_review", corrections }, body, { store });
  }

  const suspended: string[] = [];
  if (d.produced_by) {
    const ep = store.nodes.get(d.produced_by);
    if (ep && ep.type === "episode") {
      updateNode(store.root, ep.id, { outcome: "corrected" }, undefined, { store });
      for (const used of new Set(ep.uses)) {
        const u = store.nodes.get(used);
        if (!u || u.type !== "procedure") continue;
        const r = recomputeProcedureCache(store, used);
        if (r.to === "suspended" && r.from !== "suspended") suspended.push(used);
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
  // The records of other stores this decision rested on receive the correction too, once a turn gives it provenance.
  let remote: CorrectionResult["remote"] = [];
  const targets = remoteDecisionTargets(store, d);
  if (targets.length && turn) {
    const info = turnInfo(store, turn);
    const events: OutboxEvent[] = targets.map((t) => ({ event: correctedEventId(t, event), kind: "corrected", target: t, turn: info, at, origin: { decision: decisionId, event }, reason, value: opts.value, cell: d.target ? { unit: d.target.unit, field: d.target.field } : null, created: nowIso() }));
    remote = enqueue(store.root, events).map((e) => ({ event: e.event, target: e.target }));
  }
  return { decision: decisionId, replacement, needs_review: needsReview.sort(), suspended: suspended.sort(), episode: d.produced_by, event, already: false, remote };
}
