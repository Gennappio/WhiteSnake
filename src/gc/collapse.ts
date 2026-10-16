import { join } from "node:path";
import { randomSuffix } from "../schema/ids.js";
import type { Episode, Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode, currentTurn, updateNode } from "../store/ops.js";
import { CliError, nowIso, writeText } from "../util.js";

export interface CollapseResult {
  procedure: string;
  steps: number;
  entrypoint: string;
}

/**
 * Collapse a parent episode whose children were all resolved deterministically into one composed procedure.
 * The agent is no longer needed inside the subtree: next time the composed procedure is the resolution.
 */
export function collapseEpisode(store: LoadedStore, episodeId: string): CollapseResult {
  const parent = store.nodes.get(episodeId);
  if (!parent || parent.type !== "episode") throw new CliError(`${episodeId} is not an episode`, 1);
  const children = parent.children.filter((c): c is string => typeof c === "string").map((id) => store.nodes.get(id)).filter((n): n is Episode => !!n && n.type === "episode");
  if (!children.length) throw new CliError(`${episodeId} has no local child episodes to collapse`, 2);
  const offending = children.filter((c) => c.outcome !== "success" || c.resolution === "agent");
  if (offending.length) throw new CliError(`cannot collapse: ${offending.map((c) => `${c.id} (${c.outcome}, ${c.resolution})`).join(", ")} still need an agent or did not succeed`, 2);

  const ordered = [...children].sort((a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id));
  const usedProcedures = [...new Set(ordered.flatMap((c) => c.uses.filter((u) => store.nodes.get(u)?.type === "procedure")))];
  const lines: string[] = [`# Composed procedure for "${parent.title}"`, "", `Collapsed from ${ordered.length} deterministic episodes on ${nowIso()}. Run the steps in order; each step names the procedure it reuses and the execution it reproduces.`, ""];
  ordered.forEach((c, i) => {
    const procs = c.uses.map((u) => store.nodes.get(u)).filter((n): n is Procedure => !!n && n.type === "procedure");
    const execs = c.produces.map((p) => store.nodes.get(p)).filter((n) => n && n.type === "evidence" && n.kind === "execution");
    const produced = c.produces.map((p) => store.nodes.get(p)).filter((n) => n && n.type === "decision");
    lines.push(`## Step ${i + 1}: ${c.title} (${c.resolution})`);
    for (const p of procs) lines.push(`- run \`${p.entrypoint}\` (${p.id})`);
    for (const e of execs) if (e && e.type === "evidence") lines.push(`- as recorded in ${e.id}: ${e.locator.section ?? e.locator.path ?? ""}`);
    for (const d of produced) if (d && d.type === "decision" && d.target) lines.push(`- produces ${d.target.field} for ${d.target.unit} (criterion ${d.warrant.join(", ") || "none"})`);
    lines.push("");
  });
  const name = `composed_${randomSuffix(8)}`;
  const entrypoint = join("procedures", name, "STEPS.md");
  writeText(join(store.root, entrypoint), `${lines.join("\n")}\n`);
  const turn = currentTurn(store.root);
  const proc = createNode(
    store.root,
    "procedure",
    {
      title: `Composed: ${parent.title}`,
      resolution: "skill",
      entrypoint,
      uses: usedProcedures,
      applicability: [`units of the same kind as ${parent.title}`, "every step's own applicability holds"],
      abstain_when: ["any step's procedure abstains or is suspended"],
      regression_cases: [],
      promoted_from: ordered.map((c) => c.id),
      history: [{ at: nowIso(), from: null, to: "provisional", caused_by: turn, reason: `collapsed from ${ordered.length} deterministic episodes of ${parent.id}` }],
      produced_by: parent.id,
    },
    `Collapsed subtree of ${parent.id}. The agent call moves up one level: next time, resolve "${parent.title}" with this procedure instead of re-deriving each step.`,
    { store, causedBy: turn },
  );
  updateNode(store.root, parent.id, { uses: [...new Set([...parent.uses, proc.id])] }, undefined, { store });
  return { procedure: proc.id, steps: ordered.length, entrypoint };
}
