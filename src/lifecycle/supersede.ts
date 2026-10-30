import type { LoadedStore } from "../store/files.js";
import { createNode, currentTurn } from "../store/ops.js";
import { CliError } from "../util.js";
import { compareProcedures, type CompareReport } from "./compare.js";
import { markSuperseded } from "./procedures.js";
import { scorecard, type ThresholdEval } from "./scorecard.js";

export interface SupersedeResult {
  new: string;
  old: string;
  /** The choice decision that records why the replacement was made. */
  decision: string;
  comparison: string | null;
  report: CompareReport;
  thresholds: ThresholdEval[];
}

/**
 * The replacement itself, as a CLI rule rather than an agent's judgement. The new procedure must be trusted (shown
 * uses of its own), must dominate the old one on everything recorded about it, and must clear every threshold the
 * researcher declared. Then a choice decision records the replacement with the comparison as its data, and the old
 * procedure becomes superseded: out of the ladder, its outputs standing.
 */
export function supersedeProcedure(store: LoadedStore, newId: string, opts: { old?: string; episode?: string | null; actor?: string } = {}): SupersedeResult {
  const nw = store.nodes.get(newId);
  if (!nw || nw.type !== "procedure") throw new CliError(`${newId} is not a procedure`, 1);
  if (!nw.supersedes.length) throw new CliError(`${newId} lists nothing in supersedes; register the new version with "supersedes" and a "justification" first`, 2);
  if (opts.old && !nw.supersedes.includes(opts.old)) throw new CliError(`${newId} does not list ${opts.old} in supersedes (it lists ${nw.supersedes.join(", ")})`, 2);
  if (!opts.old && nw.supersedes.length > 1) throw new CliError(`${newId} supersedes several procedures (${nw.supersedes.join(", ")}); pass --old to pick one`, 2);
  const oldId = opts.old ?? nw.supersedes[0]!;
  const old = store.nodes.get(oldId);
  if (!old || old.type !== "procedure") throw new CliError(`${oldId} is not a procedure`, 1);
  if (old.state === "superseded" || old.state === "retired") throw new CliError(`${oldId} is already ${old.state}`, 2);
  if (nw.state !== "trusted") {
    throw new CliError(`${newId} is ${nw.state}, not trusted: ${nw.counters.shown_uses} shown use(s), ${store.config.promotion.shown_uses_to_trust} needed. Keep running both procedures on new inputs, list both in the episode's uses and show the value; the replacement waits for trust.`, 2);
  }
  const report = compareProcedures(store, oldId, newId, { episode: opts.episode ?? null, record: true });
  if (!report.dominates) {
    const divergent = report.cases.filter((c) => c.verdict === "regression" || c.verdict === "diverge" || c.verdict === "changed_unverified").map((c) => `${c.key} [${c.args.join(" ")}]: ${c.verdict}`);
    throw new CliError(`${newId} does not dominate ${oldId}: ${report.blocking.join("; ") || "no improvement shown"}. Comparison recorded as ${report.evidence}.${divergent.length ? ` Cases for the researcher: ${divergent.join("; ")}` : ""}`, 2, report);
  }
  const card = scorecard(store, newId);
  const unmet = card.thresholds.filter((t) => t.status !== "met");
  if (unmet.length) {
    throw new CliError(`${newId} does not clear ${unmet.length} threshold criterion(s): ${unmet.map((t) => `${t.criterion} ${t.metric} <= ${t.max} is ${t.status}${t.value !== null ? ` (${t.value})` : ""}${t.status === "insufficient" ? ` with ${t.observed} of ${t.min_shown} observed outputs` : ""}`).join("; ")}. Comparison recorded as ${report.evidence}.`, 2, { thresholds: card.thresholds, report });
  }
  const turn = currentTurn(store.root);
  const summary = `same ${report.counts.same}, fixed ${report.counts.fixed}, gained ${report.counts.gained}, agree ${report.counts.agree}, stale ${report.counts.stale}`;
  const decision = createNode(
    store.root,
    "decision",
    {
      title: `Supersession: ${newId} replaces ${oldId}`,
      kind: "choice",
      status: "active",
      claim: `${newId} supersedes ${oldId}: ${report.improvement.join("; ")}`,
      qualifier: { confidence: 1, scope: `procedures of this store; comparison on ${report.platform}: ${summary}` },
      fragility: "mechanical",
      target: null,
      data: report.evidence ? [report.evidence] : [],
      warrant: card.thresholds.map((t) => t.criterion),
      backing: nw.justification?.evidence ?? [],
      depends_on: [oldId, newId],
      produced_by: opts.episode ?? null,
    },
    [nw.justification?.text ?? "", `Comparison ${report.evidence ?? "(not recorded)"}: ${summary}; ${report.improvement.join("; ")}.`, card.thresholds.length ? `Thresholds: ${card.thresholds.map((t) => `${t.criterion} ${t.status}`).join(", ")}.` : "No threshold criterion declared; the default rule applied."].filter(Boolean).join("\n\n"),
    { store, causedBy: turn, actor: opts.actor },
  );
  markSuperseded(store, oldId, `superseded by ${newId}: ${report.improvement.join("; ")} (decision ${decision.id}, comparison ${report.evidence ?? "not recorded"})`, turn);
  return { new: newId, old: oldId, decision: decision.id, comparison: report.evidence, report, thresholds: card.thresholds };
}
