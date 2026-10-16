import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { commitAll, openParentBranch } from "../branch.js";
import { randomSuffix } from "../schema/ids.js";
import { loadConfig } from "../store/config.js";
import { loadStore } from "../store/files.js";
import { createNode, currentTurn, updateNode } from "../store/ops.js";
import { CliError, nowIso, sha256, writeText } from "../util.js";
import { loadSchema, runHeadless, type RunnerHarness } from "./runner.js";

export interface Task {
  id: string;
  parent_store: string;
  question: string;
  why: string;
  inputs: string[];
  acceptance_criteria: string[];
  allowed_outputs: string[];
  created: string;
}

export interface ChildOutput {
  status: "completed" | "blocked" | "needs_context";
  result: string;
  episode_id: string;
  decision_ids: string[];
  evidence_ids: string[];
  uncertainties: string[];
  new_questions: string[];
  question_for_parent?: string;
}

export interface DelegationResult {
  task: Task;
  child_store: string;
  branch: string;
  worktree: string;
  child_commit: string | null;
  output: ChildOutput | null;
  parent_episode: string;
  parent_evidence: string;
  parent_artifact: string;
  session: string | null;
}

/**
 * Delegate a question to a child store: the parent never touches the child's records directly. The child works
 * on the parent's branch in its own worktree, answers with a structured result, and the parent records that result
 * as execution evidence plus an episode whose child is a remote reference.
 */
export function delegateTask(parentRoot: string, childRoot: string, spec: { question: string; why?: string; inputs?: string[]; acceptance?: string[]; harness: RunnerHarness; model?: string | null; budgetUsd?: number }): DelegationResult {
  const parentCfg = loadConfig(parentRoot);
  const childCfg = loadConfig(childRoot);
  const open = openParentBranch(childRoot, parentCfg.id);
  const work = open.worktree;
  const task: Task = {
    id: `task_${randomSuffix()}`,
    parent_store: parentCfg.id,
    question: spec.question,
    why: spec.why ?? "",
    inputs: spec.inputs ?? [],
    acceptance_criteria: spec.acceptance ?? ["cite the evidence and the criterion for every value", "say what remains uncertain"],
    allowed_outputs: ["evidence", "decision", "question"],
    created: nowIso(),
  };
  writeText(join(work, ".autosoft", "tasks", `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`);

  const prompt = [
    `You are working in the AutoSoft store "${childCfg.name}" (${childCfg.id}) on behalf of the parent store "${parentCfg.id}", task ${task.id}.`,
    `Task: ${task.question}`,
    task.why ? `Why it matters to the parent: ${task.why}` : "",
    task.inputs.length ? `Inputs: ${task.inputs.join(", ")}` : "",
    `Acceptance criteria: ${task.acceptance_criteria.join("; ")}`,
    "Follow the autosoft skill: open an episode for this task, consult precedents, record evidence and decisions through the autosoft CLI, close the episode, run `autosoft validate`.",
    'Finish with JSON only: {"status": "completed|blocked|needs_context", "result": string, "episode_id": string, "decision_ids": [..], "evidence_ids": [..], "uncertainties": [..], "new_questions": [..], "question_for_parent": string or null (set only when needs_context)}.',
  ]
    .filter(Boolean)
    .join("\n");

  const run = runHeadless(work, prompt, { harness: spec.harness, schema: loadSchema("child-output.json"), model: spec.model ?? null, budgetUsd: spec.budgetUsd ?? 10 });
  const output = isChildOutput(run.json) ? run.json : null;
  writeText(join(work, ".autosoft", "tasks", `${task.id}.output.json`), `${JSON.stringify({ status: run.status, text: run.text, json: run.json }, null, 2)}\n`);
  const childCommit = commitAll(work, `store: task ${task.id} for ${parentCfg.id}`);
  if (run.status !== 0 && !output) throw new CliError(`child agent failed (exit ${run.status}): ${run.stderr.slice(0, 400)}`, 1);

  // Parent side: the child's answer becomes an artifact plus execution evidence, and an episode with a remote child.
  const parentStore = loadStore(parentRoot);
  const turn = currentTurn(parentRoot);
  const payload = JSON.stringify({ task, child_store: childCfg.id, branch: open.branch, child_commit: childCommit, output: output ?? run.text }, null, 2);
  const relPath = join("artifacts", "delegations", `${task.id}.json`);
  writeText(join(parentRoot, relPath), `${payload}\n`);
  const artifact = createNode(parentRoot, "artifact", { title: `Delegation ${task.id} to ${childCfg.id}`, sha256: sha256(`${payload}\n`), path: relPath, mime: "application/json", size: payload.length + 1 }, "", { store: parentStore, causedBy: turn });
  const episode = createNode(
    parentRoot,
    "episode",
    {
      title: `Delegated: ${task.question.slice(0, 80)}`,
      resolution: "agent",
      children: [{ store: childCfg.id, id: output?.episode_id ?? task.id }],
      outcome: output?.status === "completed" ? "success" : output?.status === "blocked" ? "failure" : "open",
      ended: output?.status === "completed" || output?.status === "blocked" ? nowIso() : null,
    },
    `Task ${task.id} delegated to store ${childCfg.id} on ${open.branch}.\n\n${output ? output.result : run.text}`,
    { store: parentStore, causedBy: turn },
  );
  const evidence = createNode(
    parentRoot,
    "evidence",
    {
      title: `Child answer for ${task.id} (${childCfg.id})`,
      kind: "execution",
      locator: { artifact: artifact.id, section: output ? `decisions ${output.decision_ids.join(", ") || "none"}` : "raw output" },
      produced_by: episode.id,
    },
    output ? `${output.result}\n\nchild decisions: ${output.decision_ids.join(", ") || "none"}\nchild evidence: ${output.evidence_ids.join(", ") || "none"}\nuncertainties: ${output.uncertainties.join("; ") || "none"}` : run.text,
    { store: parentStore, causedBy: turn },
  );
  updateNode(parentRoot, episode.id, { produces: [evidence.id, artifact.id] }, undefined, { store: parentStore });
  if (existsSync(join(parentRoot, ".git"))) commitAll(parentRoot, `store: delegation ${task.id} to ${childCfg.id}`);

  return { task, child_store: childCfg.id, branch: open.branch, worktree: work, child_commit: childCommit, output, parent_episode: episode.id, parent_evidence: evidence.id, parent_artifact: artifact.id, session: run.sessionId };
}

function isChildOutput(v: unknown): v is ChildOutput {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["status"] === "string" && typeof o["result"] === "string" && typeof o["episode_id"] === "string" && Array.isArray(o["decision_ids"]);
}

/** Resolve the path of a child store by id, from the parent config's `stores` map or an explicit directory. */
export function childRootFor(parentRoot: string, childIdOrPath: string): string {
  if (existsSync(join(childIdOrPath, "autosoft.yaml"))) return childIdOrPath;
  const cfg = loadConfig(parentRoot);
  const mapped = cfg.stores[childIdOrPath];
  if (mapped) {
    const abs = mapped.startsWith("/") ? mapped : join(parentRoot, mapped);
    if (existsSync(join(abs, "autosoft.yaml"))) return abs;
  }
  throw new CliError(`unknown child store ${childIdOrPath}: pass a directory or register it under stores: in autosoft.yaml`, 1);
}

export function readTask(work: string, taskId: string): Task | null {
  const p = join(work, ".autosoft", "tasks", `${taskId}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Task) : null;
}

export function relativeTo(root: string, p: string): string {
  return relative(root, p);
}
