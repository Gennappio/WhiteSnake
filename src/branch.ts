import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { recomputeAll } from "./lifecycle/procedures.js";
import { loadStore, splitFrontmatter } from "./store/files.js";
import { writeSnapshot } from "./store/journal.js";
import { errorsOf, validateStore } from "./store/validate.js";
import { CliError, ensureDir, isRecord, stableStringify } from "./util.js";

/**
 * Per-parent branches. Every use of a child store by a parent happens on `parent/<parent-store-id>` in its own
 * worktree, rebased on main when opened. Reconciliation into main is explicit; a conflict never leaves partial state.
 * The cached state of procedures is derived from events, so a conflict confined to those fields is not a conflict:
 * it is resolved by taking either side and deriving again once the two histories sit in one tree.
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

const CACHE_FIELDS = ["state", "counters", "history"];

/** True when the two sides of a conflicted file are the same procedure record apart from the fields the CLI derives. */
function cacheOnlyConflict(cwd: string, file: string): boolean {
  if (!file.startsWith("knowledge/procedures/")) return false;
  const side = (stage: 2 | 3): { fm: string; body: string } | null => {
    const r = gitTry(cwd, ["show", `:${stage}:${file}`]);
    if (r.status !== 0) return null;
    const split = splitFrontmatter(`${r.stdout}\n`);
    if (!split) return null;
    let fm: unknown;
    try {
      fm = YAML.parse(split.frontmatter);
    } catch {
      return null;
    }
    if (!isRecord(fm)) return null;
    for (const k of CACHE_FIELDS) delete fm[k];
    return { fm: stableStringify(fm), body: split.body.trim() };
  };
  const ours = side(2);
  const theirs = side(3);
  return !!ours && !!theirs && ours.fm === theirs.fm && ours.body === theirs.body;
}

function unmergedFiles(cwd: string): string[] {
  return gitTry(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
}

/** Resolve the conflicted files that differ only in derived procedure caches, taking one side; the rest are real conflicts. */
function resolveCacheConflicts(cwd: string, take: "ours" | "theirs"): { resolved: string[]; real: string[] } {
  const resolved: string[] = [];
  const real: string[] = [];
  for (const f of unmergedFiles(cwd)) {
    if (cacheOnlyConflict(cwd, f)) {
      git(cwd, ["checkout", `--${take}`, "--", f]);
      git(cwd, ["add", "--", f]);
      resolved.push(f);
    } else real.push(f);
  }
  return { resolved, real };
}

export interface OpenResult {
  branch: string;
  worktree: string;
  created: boolean;
  rebased: boolean;
  behind_before: number;
  /** Procedures whose cache was derived again after the rebase, because main brought events of its own. */
  recomputed: string[];
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
  let recomputed: string[] = [];
  if (behind > 0) {
    let r = gitTry(dir, ["rebase", "-q", "main"]);
    // A commit that only moved a procedure's cache is replayed by taking its side; the cache is derived again below.
    for (let guard = 0; r.status !== 0 && guard < 100; guard++) {
      const { resolved, real } = resolveCacheConflicts(dir, "theirs");
      if (real.length || !resolved.length) break;
      r = gitTry(dir, ["-c", "core.editor=true", "rebase", "--continue"]);
    }
    if (r.status !== 0) {
      const files = unmergedFiles(dir);
      gitTry(dir, ["rebase", "--abort"]);
      throw new CliError(`rebasing ${branch} on main conflicts (${files.join(", ") || r.stderr.split("\n")[0] || "unknown"}); nothing was changed. Reconcile main and the branch explicitly.`, 3, files.map((f) => ({ file: f, kind: conflictKind(f) })));
    }
    rebased = true;
    // git rewrote files in the worktree: they are not hand writes, so the journal baseline moves with them.
    writeSnapshot(dir);
    recomputed = recomputeAll(loadStore(dir)).filter((x) => x.changed).map((x) => x.id);
    if (recomputed.length) {
      commitAll(dir, "store: recompute derived state after rebase");
      writeSnapshot(dir);
    }
  }
  return { branch, worktree: dir, created, rebased, behind_before: behind, recomputed };
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
  /** Procedures whose cache was derived again from the events of both sides. */
  recomputed: string[];
  /** Procedure files that conflicted only in their derived cache and were resolved by deriving it again. */
  cache_conflicts_resolved: string[];
}

function conflictKind(file: string): MergeResult["conflicts"][number]["kind"] {
  if (file.startsWith("knowledge/evidence/") || file.startsWith("knowledge/artifacts/")) return "evidence";
  if (file.startsWith("knowledge/decisions/") || file.startsWith("knowledge/questions/")) return "decision";
  if (file.startsWith("knowledge/procedures/") || file.startsWith("procedures/")) return "procedure";
  return "other";
}

/**
 * Reconcile a parent branch into main with a merge commit. Evidence is append-only and merges by itself; a conflict
 * confined to the derived cache of a procedure is resolved by deriving it again; any other conflict on decisions,
 * criteria or procedures aborts the merge (exit 4) and is listed for explicit reconciliation. The merged tree is
 * validated before it is committed: an invalid result is abandoned the same way.
 */
export function mergeParentBranch(root: string, parentId: string): MergeResult {
  requireRepo(root);
  const branch = parentBranch(parentId);
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== "main") throw new CliError(`the store checkout must be on main to merge (currently ${current})`, 1);
  if (git(root, ["status", "--porcelain"])) throw new CliError("main has uncommitted changes; commit or stash them first", 1);
  const commits = Number(git(root, ["rev-list", "--count", `main..${branch}`]) || 0);
  if (commits === 0) return { branch, merged: false, commits: 0, conflicts: [], recomputed: [], cache_conflicts_resolved: [] };
  const r = gitTry(root, ["merge", "--no-ff", "--no-commit", "-q", branch]);
  let cacheConflicts: string[] = [];
  if (r.status !== 0) {
    const { resolved, real } = resolveCacheConflicts(root, "ours");
    if (real.length || !resolved.length) {
      const files = real.length ? real : unmergedFiles(root);
      gitTry(root, ["merge", "--abort"]);
      const conflicts = files.map((f) => ({ file: f, kind: conflictKind(f) }));
      throw new CliError(`merge of ${branch} conflicts on ${files.length} file(s): ${files.join(", ")}; nothing was changed`, 4, conflicts);
    }
    cacheConflicts = resolved;
  }
  // Events from both sides now sit in one tree: every procedure's cache is derived again before anything is committed.
  const recomputed = recomputeAll(loadStore(root)).filter((x) => x.changed).map((x) => x.id);
  git(root, ["add", "-A"]);
  const errors = errorsOf(validateStore(loadStore(root)));
  if (errors.length) {
    gitTry(root, ["merge", "--abort"]);
    throw new CliError(`merge of ${branch} would leave the store invalid (${errors.map((e) => `${e.code} ${e.id ?? ""}`.trim()).slice(0, 5).join(", ")}${errors.length > 5 ? ", …" : ""}); nothing was changed`, 4, errors);
  }
  git(root, ["commit", "-q", "-m", `store: reconcile ${branch} into main`]);
  writeSnapshot(root);
  return { branch, merged: true, commits, conflicts: [], recomputed, cache_conflicts_resolved: cacheConflicts };
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
