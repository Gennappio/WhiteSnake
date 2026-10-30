import type { DatabaseSync } from "node:sqlite";
import { getNode, listNodes, precedent, resolveRef, type NodeRow, type PrecedentRow } from "../index/queries.js";

export interface Resolution {
  /** cached: reuse an accepted decision; review: a decision exists but is under review, redo it; code: run a trusted procedure; agent: work it out. */
  mode: "cached" | "review" | "code" | "agent";
  decision: string | null;
  decision_status: string | null;
  trusted_procedures: NodeRow[];
  provisional_procedures: NodeRow[];
  /** A rewrite running alongside the procedure it means to replace: both are live, the new one lists the old in supersedes. */
  shadow: { old: string; new: string; new_state: string }[];
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
  const liveIds = new Set([...trusted, ...provisional].map((r) => r.id));
  const shadow: Resolution["shadow"] = [];
  for (const row of [...trusted, ...provisional]) {
    const p = getNode(db, row.id);
    if (!p || p.type !== "procedure") continue;
    for (const old of p.supersedes) if (liveIds.has(old)) shadow.push({ old, new: p.id, new_state: p.state });
  }
  shadow.sort((a, b) => a.new.localeCompare(b.new) || a.old.localeCompare(b.old));
  const shadowAdvice = shadow
    .map((s) =>
      s.new_state === "trusted"
        ? `${s.new} is trusted and supersedes ${s.old}: run \`whitesnake procedure supersede ${s.new}\` to retire ${s.old} from this ladder once the comparison shows no regression.`
        : `${s.new} (provisional) is meant to replace ${s.old}: run both on this input, list both in the episode's uses and show one value; if they disagree keep ${s.old}'s value, record ${s.new}'s output as rebuttal evidence and raise a question.`,
    )
    .join(" ");
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
  if (shadowAdvice) advice = `${advice} ${shadowAdvice}`;
  return { mode, decision, decision_status: status, trusted_procedures: trusted, provisional_procedures: provisional, shadow, precedents, advice };
}
