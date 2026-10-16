import type { DatabaseSync } from "node:sqlite";
import { listNodes, precedent, resolveRef, type NodeRow, type PrecedentRow } from "../index/queries.js";

export interface Resolution {
  mode: "cached" | "code" | "agent";
  decision: string | null;
  trusted_procedures: NodeRow[];
  provisional_procedures: NodeRow[];
  precedents: PrecedentRow[];
  advice: string;
}

/**
 * The resolution ladder: an accepted result for the same cell is reused; otherwise a trusted procedure is
 * preferred; otherwise the agent works, using provisional procedures where they apply and recording them.
 */
export function resolve(db: DatabaseSync, unit: string | undefined, field: string | undefined, text: string): Resolution {
  const decision = unit && field ? resolveRef(db, `${unit}/${field}`) : null;
  const trusted = listNodes(db, { type: "procedure", status: "trusted" });
  const provisional = listNodes(db, { type: "procedure", status: "provisional" });
  const precedents = text.trim() ? precedent(db, text, { limit: 5 }) : [];
  let mode: Resolution["mode"] = "agent";
  let advice: string;
  if (decision) {
    mode = "cached";
    advice = `An accepted decision already exists for ${unit}/${field}: ${decision}. Reuse it (autosoft why ${decision}) unless the researcher asked to redo it.`;
  } else if (trusted.length) {
    mode = "code";
    advice = `Run a trusted procedure if its applicability matches, record its output as execution evidence and list it in the episode's uses: ${trusted.map((p) => p.id).join(", ")}.`;
  } else if (provisional.length) {
    advice = `No trusted procedure. Provisional procedures may be used but their output must be checked against your own reading: ${provisional.map((p) => p.id).join(", ")}.`;
  } else {
    advice = "No procedure applies: work it out, cite evidence, and consider registering what you did as a procedure.";
  }
  return { mode, decision, trusted_procedures: trusted, provisional_procedures: provisional, precedents, advice };
}
