import { loadConfig } from "../store/config.js";
import { loadSchema, runHeadless, type RunnerHarness } from "./runner.js";

export interface AskResult {
  answer: string;
  records: string[];
  confidence: number;
  session: string | null;
  raw: string;
}

/** Ask a coding agent a question about the store; it must answer from CLI queries and cite record ids. */
export function askStore(root: string, question: string, opts: { harness: RunnerHarness; model?: string | null; budgetUsd?: number }): AskResult {
  const cfg = loadConfig(root);
  const prompt = [
    `You are answering a question about the WhiteSnake store "${cfg.name}" (${cfg.id}) in this directory.`,
    "Use only the whitesnake CLI to look things up: `whitesnake why <id|unit/field>`, `whitesnake precedent <text>`, `whitesnake get <id>`, `whitesnake affected <id>`, `whitesnake frontier`, `whitesnake timeline`, `whitesnake ls`.",
    "Do not modify the store. Cite the ids of the records your answer rests on.",
    `Question: ${question}`,
    'Reply with JSON only: {"answer": string, "records": [ids], "confidence": 0..1}.',
  ].join("\n");
  const r = runHeadless(root, prompt, { harness: opts.harness, schema: loadSchema("ask-output.json"), model: opts.model ?? null, budgetUsd: opts.budgetUsd ?? 3 });
  const j = (r.json ?? {}) as Partial<AskResult>;
  return {
    answer: typeof j.answer === "string" ? j.answer : r.text.trim(),
    records: Array.isArray(j.records) ? j.records.map(String) : [],
    confidence: typeof j.confidence === "number" ? j.confidence : 0,
    session: r.sessionId,
    raw: r.text,
  };
}
