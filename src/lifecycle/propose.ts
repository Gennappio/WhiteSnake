import { chmodSync } from "node:fs";
import { join } from "node:path";
import { randomSuffix } from "../schema/ids.js";
import type { Evidence, Procedure } from "../schema/nodes.js";
import type { LoadedStore } from "../store/files.js";
import { createNode, currentTurn } from "../store/ops.js";
import { CliError, nowIso, truncate, writeText } from "../util.js";
import { parseOutput } from "./regression.js";

/** Split a shell command into tokens, honouring single and double quotes. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const shellQuote = (s: string): string => (/^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export interface ProposeResult {
  procedure: Procedure;
  entrypoint: string;
  template: string;
  cases: string[];
  parameters: number;
}

/**
 * Turn recorded executions into a procedure skeleton: a script whose varying arguments become positional parameters,
 * one regression case per execution (its inputs and its recorded output), and a provisional procedure node that
 * remembers which episodes it was distilled from. The agent then refines applicability and abstention.
 */
export function proposeFromEvidence(store: LoadedStore, evidenceIds: string[], opts: { name?: string; title?: string; applicability?: string[] } = {}): ProposeResult {
  const evs = evidenceIds.map((id) => {
    const n = store.nodes.get(id);
    if (!n || n.type !== "evidence") throw new CliError(`${id} is not an evidence record`, 1);
    if (n.kind !== "execution" || !n.execution) throw new CliError(`${id} is not an execution with a recorded command (use autosoft run)`, 2);
    return n as Evidence & { execution: NonNullable<Evidence["execution"]> };
  });
  if (!evs.length) throw new CliError("pass at least one execution evidence id", 1);
  const tokenLists = evs.map((e) => tokenize(e.execution.command));
  const first = tokenLists[0]!;
  const aligned = tokenLists.every((t) => t.length === first.length);
  const params: number[] = [];
  if (aligned && evs.length > 1) {
    // Several executions: whatever varies between them is a parameter; constant tokens stay literal.
    first.forEach((tok, i) => {
      if (tokenLists.some((t) => t[i] !== tok)) params.push(i);
    });
  } else if (aligned) {
    // One execution: no variation to observe, so the input files it names become the parameters.
    first.forEach((tok, i) => {
      if (i > 0 && Object.keys(evs[0]!.execution.input_hashes).includes(tok)) params.push(i);
    });
  } else {
    first.forEach((tok, i) => {
      if (i > 0 && Object.keys(evs[0]!.execution.input_hashes).includes(tok)) params.push(i);
    });
  }
  const template = first.map((tok, i) => (params.includes(i) ? `"$${params.indexOf(i) + 1}"` : shellQuote(tok))).join(" ");
  const name = opts.name ?? `proposed_${randomSuffix(8)}`;
  if (!/^[a-z0-9_-]+$/.test(name)) throw new CliError("--name must be lowercase letters, digits, _ or -", 1);
  const dir = join("procedures", name);
  const entrypoint = join(dir, "run.sh");
  writeText(join(store.root, entrypoint), `#!/bin/sh\n# Proposed by autosoft from recorded executions: ${evs.map((e) => e.id).join(", ")}\n# Parameters: ${params.length ? params.map((_, k) => `$${k + 1}`).join(" ") : "none"}\nset -e\n${template}\n`);
  chmodSync(join(store.root, entrypoint), 0o755);
  const cases: string[] = [];
  evs.forEach((e, k) => {
    const toks = tokenLists[k]!;
    const input = params.map((i) => toks[i] ?? "");
    const expected = parseOutput(store.bodies.get(e.id) ?? "");
    const file = join(dir, "cases", `${String(k + 1).padStart(2, "0")}.json`);
    writeText(join(store.root, file), `${JSON.stringify({ input, expected, from_evidence: e.id }, null, 2)}\n`);
    cases.push(file);
  });
  const episodes = [...new Set(evs.map((e) => e.produced_by).filter((x): x is string => !!x))];
  const turn = currentTurn(store.root);
  const procedure = createNode(
    store.root,
    "procedure",
    {
      title: opts.title ?? `Proposed: ${truncate(template, 70)}`,
      resolution: "code",
      entrypoint,
      uses: [],
      applicability: opts.applicability ?? [`inputs shaped like the recorded executions (${evs.length} case${evs.length === 1 ? "" : "s"})`],
      abstain_when: ["inputs of a different shape than the regression cases", "the command's tools are not available on this machine"],
      regression_cases: cases,
      promoted_from: episodes,
      history: [{ at: nowIso(), from: null, to: "provisional", caused_by: turn, reason: `proposed from ${evs.length} recorded execution(s): ${evs.map((e) => e.id).join(", ")}` }],
      produced_by: null,
    },
    `Skeleton distilled from recorded executions. Review the template in ${entrypoint}, tighten applicability and abstention, then let shown uses promote it.\n\nTemplate: ${template}`,
    { store, causedBy: turn },
  ) as Procedure;
  return { procedure, entrypoint, template, cases, parameters: params.length };
}
