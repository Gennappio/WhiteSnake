import type { DatabaseSync } from "node:sqlite";
import { getNode, listNodes, precedent, resolveRef, type NodeRow, type PrecedentRow } from "../index/queries.js";

export interface Resolution {
  /** cached: reuse an accepted decision; review: a decision exists but is under review, redo it; code: run a trusted procedure; agent: work it out. */
  mode: "cached" | "review" | "code" | "agent";
  decision: string | null;
  decision_status: string | null;
  trusted_procedures: NodeRow[];
  provisional_procedures: NodeRow[];
  precedents: PrecedentRow[];
  advice: string;
}

/**
 * The resolution ladder. An accepted (active) result for the same cell is reused. A result under review after a
 * correction is never reused: it must be redone and superseded. Otherwise a trusted procedure is preferred, and
 * otherwise the agent works, using provisional procedures where they apply and recording them. A merely proposed
 * result is pointed out as something to check, not to reuse.
 */
export function resolve(db: DatabaseSync, unit: string | undefined, field: string | undefined, text: string): Resolution {
  const decision = unit && field ? resolveRef(db, `${unit}/${field}`) : null;
  const node = decision ? (getNode(db, decision) as unknown as { status?: string } | null) : null;
  const status = node?.status ?? null;
  const trusted = listNodes(db, { type: "procedure", status: "trusted" });
  const provisional = listNodes(db, { type: "procedure", status: "provisional" });
  const precedents = text.trim() ? precedent(db, text, { limit: 5 }) : [];
  const ladder = trusted.length
    ? `Run a trusted procedure if its applicability matches, record its output as execution evidence and list it in the episode's uses: ${trusted.map((p) => p.id).join(", ")}.`
    : provisional.length
      ? `No trusted procedure. Provisional procedures may be used but their output must be checked against your own reading: ${provisional.map((p) => p.id).join(", ")}.`
      : "No procedure applies: work it out, cite evidence, and consider registering what you did as a procedure.";
  let mode: Resolution["mode"];
  let advice: string;
  if (decision && status === "active") {
    mode = "cached";
    advice = `An accepted decision already exists for ${unit}/${field}: ${decision}. Reuse it (whitesnake why ${decision}) unless the researcher asked to redo it.`;
  } else if (decision && status === "needs_review") {
    mode = "review";
    advice = `${decision} for ${unit}/${field} is under review after a correction (whitesnake why ${decision} shows what it rested on). Do not reuse its value: redo the step with the current criteria, cite the evidence, and record a new decision that supersedes ${decision}. ${ladder}`;
  } else {
    mode = trusted.length ? "code" : "agent";
    advice = decision && status === "proposed" ? `A proposed decision ${decision} exists for ${unit}/${field} but was never accepted by the researcher: check it rather than reuse it, then confirm it or supersede it. ${ladder}` : ladder;
  }
  return { mode, decision, decision_status: status, trusted_procedures: trusted, provisional_procedures: provisional, precedents, advice };
}
