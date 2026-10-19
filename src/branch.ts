import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError, ensureDir } from "./util.js";
import { writeSnapshot } from "./store/journal.js";

/**
 * Per-parent branches. Every use of a child store by a parent happens on `parent/<parent-store-id>` in its own
 * worktree, rebased on main when opened. Reconciliation into main is explicit; a conflict never leaves partial state.
 */
export function parentBranch(parentId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(parentId)) throw new CliError(`invalid parent id ${parentId}`, 1);
  return `parent/${parentId}`;
}

/** Run git and return trimmed stdout; a non-zero exit is an error. */
function git(cwd: string, args: string[]): string {
  const r = gitTry(cwd, args);
  if (r.status !== 0) throw new CliError(`git ${args.join(" ")} failed: ${r.stderr}`, 1);
  return r.stdout;
}

/** Run git and report the outcome without throwing. */
function gitTry(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function requireRepo(root: string): void {
  if (!existsSync(join(root, ".git"))) throw new CliError(`${root} is not a git repository; branching needs one (whitesnake init creates it)`, 1);
}

export function worktreeDir(root: string, parentId: string): string {
  return join(root, ".whitesnake", "worktrees", parentId);
}

export interface OpenResult {
  branch: string;
  worktree: string;
  created: boolean;
  rebased: boolean;
  behind_before: number;
}

/** Create the parent branch and worktree if needed, then rebase the branch on main. Conflicts abort cleanly (exit 3). */
export function openParentBranch(root: string, parentId: string): OpenResult {
  requireRepo(root);
  const branch = parentBranch(parentId);
  const exists = gitTry(root, ["rev-parse", "--verify", "--quiet", branch]).status === 0;
  if (!exists) git(root, ["branch", branch, "main"]);
  const dir = worktreeDir(root, parentId);
  let created = false;
  if (!existsSync(dir)) {
    ensureDir(join(root, ".whitesnake", "worktrees"));
    git(root, ["worktree", "add", "-q", dir, branch]);
    created = true;
  }
  const counts = git(root, ["rev-list", "--left-right", "--count", `${branch}...main`]).split(/\s+/);
  const behind = Number(counts[1] ?? 0);
  let rebased = false;
  if (behind > 0) {
    const r = gitTry(dir, ["rebase", "-q", "main"]);
    if (r.status !== 0) {
      gitTry(dir, ["rebase", "--abort"]);
      throw new CliError(`rebasing ${branch} on main conflicts (${r.stderr.split("\n")[0] ?? ""}); nothing was changed. Reconcile main and the branch explicitly.`, 3);
    }
    rebased = true;
    // git rewrote files in the worktree: they are not hand writes, so the journal baseline moves with them.
    writeSnapshot(dir);
  }
  return { branch, worktree: dir, created, rebased, behind_before: behind };
}

export interface BranchStatus {
  branch: string;
  parent: string;
  ahead: number;
  behind: number;
  worktree: string | null;
}

export function branchStatus(root: string): BranchStatus[] {
  requireRepo(root);
  const refs = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/parent/"]).split("\n").filter(Boolean);
  return refs.map((branch) => {
    const counts = git(root, ["rev-list", "--left-right", "--count", `${branch}...main`]).split(/\s+/);
    const parent = branch.slice("parent/".length);
    const wt = worktreeDir(root, parent);
    return { branch, parent, ahead: Number(counts[0] ?? 0), behind: Number(counts[1] ?? 0), worktree: existsSync(wt) ? wt : null };
  });
}

export interface MergeResult {
  branch: string;
  merged: boolean;
  commits: number;
  conflicts: { file: string; kind: "evidence" | "decision" | "procedure" | "other" }[];
}

function conflictKind(file: string): MergeResult["conflicts"][number]["kind"] {
  if (file.startsWith("knowledge/evidence/") || file.startsWith("knowledge/artifacts/")) return "evidence";
  if (file.startsWith("knowledge/decisions/") || file.startsWith("knowledge/questions/")) return "decision";
  if (file.startsWith("knowledge/procedures/") || file.startsWith("procedures/")) return "procedure";
  return "other";
}

/**
 * Reconcile a parent branch into main with a merge commit. Evidence is append-only and merges by itself;
 * a conflict on decisions, criteria or procedures aborts the merge (exit 4) and is listed for explicit reconciliation.
 */
export function mergeParentBranch(root: string, parentId: string): MergeResult {
  requireRepo(root);
  const branch = parentBranch(parentId);
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== "main") throw new CliError(`the store checkout must be on main to merge (currently ${current})`, 1);
  if (git(root, ["status", "--porcelain"])) throw new CliError("main has uncommitted changes; commit or stash them first", 1);
  const commits = Number(git(root, ["rev-list", "--count", `main..${branch}`]) || 0);
  if (commits === 0) return { branch, merged: false, commits: 0, conflicts: [] };
  const r = gitTry(root, ["merge", "--no-ff", "--no-edit", "-q", branch, "-m", `store: reconcile ${branch} into main`]);
  if (r.status !== 0) {
    const files = gitTry(root, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
    gitTry(root, ["merge", "--abort"]);
    const conflicts = files.map((f) => ({ file: f, kind: conflictKind(f) }));
    throw new CliError(`merge of ${branch} conflicts on ${files.length} file(s): ${files.join(", ")}; nothing was changed`, 4, conflicts);
  }
  writeSnapshot(root);
  return { branch, merged: true, commits, conflicts: [] };
}

export function commitAll(dir: string, message: string): string | null {
  if (!git(dir, ["status", "--porcelain"])) return null;
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { stdio: "ignore" });
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

/** Short hash of HEAD in a repository or worktree, or null outside git. */
export function headOf(dir: string): string | null {
  const r = gitTry(dir, ["rev-parse", "--short", "HEAD"]);
  return r.status === 0 ? r.stdout : null;
}
