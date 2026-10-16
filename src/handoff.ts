import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "./index/db.js";
import { renderReview } from "./render/html.js";
import { CONFIG_FILE, loadConfig } from "./store/config.js";
import { loadStore } from "./store/files.js";
import { errorsOf, validateStore, warningsOf } from "./store/validate.js";
import { checkProcedures, type ProcedureCheck } from "./lifecycle/regression.js";
import { CliError, ensureDir, nowIso, sha256, walkFiles, writeText } from "./util.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(here, "..", "..");
export const MANIFEST_FILE = "manifest.json";

/** Directories whose files are hashed into the manifest: the knowledge itself and everything needed to re-run it. */
const HASHED_DIRS = ["knowledge", "procedures", "corpus"];

export interface Manifest {
  format: "whitesnake-export/1";
  store_id: string;
  name: string;
  exported_at: string;
  head_commit: string | null;
  history_included: boolean;
  tool_version: string;
  skill_sha256: string;
  nodes: number;
  files: Record<string, string>;
  artifacts: { path: string; sha256: string; present: boolean }[];
  excluded: string[];
  requirements: { node: string; harnesses: string[] };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [...HASHED_DIRS.map((d) => join(root, d))]) {
    for (const f of walkFiles(dir)) {
      const rel = relative(root, f);
      if (rel.split("/").some((p) => p === ".gitkeep")) continue;
      out[rel] = sha256(readFileSync(f));
    }
  }
  out[CONFIG_FILE] = sha256(readFileSync(join(root, CONFIG_FILE)));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function toolVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(TOOL_ROOT, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function skillSha(): string {
  const p = join(TOOL_ROOT, "skill", "whitesnake", "SKILL.md");
  return existsSync(p) ? sha256(readFileSync(p)) : "";
}

/**
 * Export a store for handoff: a clone (with or without history) plus manifest.json with integrity hashes,
 * the rendered review page and the derived output. Nothing in the source store changes.
 */
export function exportStore(root: string, dest: string, opts: { history: boolean }): Manifest {
  const target = resolve(dest);
  if (existsSync(target) && readdirSync(target).length) throw new CliError(`${target} exists and is not empty`, 1);
  ensureDir(dirname(target));
  const config = loadConfig(root);
  let head: string | null = null;
  if (isGitRepo(root)) {
    head = git(root, ["rev-parse", "HEAD"]);
    const dirty = git(root, ["status", "--porcelain"]);
    if (dirty) throw new CliError("the store has uncommitted changes; commit them before exporting", 1);
    const args = ["clone", "-q", ...(opts.history ? [] : ["--depth", "1"]), `file://${root}`, target];
    execFileSync("git", args, { stdio: "ignore" });
  } else {
    cpSync(root, target, { recursive: true, filter: (src) => !src.includes(`${root}/.whitesnake`) });
  }
  rmSync(join(target, ".whitesnake"), { recursive: true, force: true });
  // Artifacts and other ignored-but-needed files travel with the export even when git ignores them.
  for (const d of ["artifacts"]) {
    const src = join(root, d);
    if (existsSync(src)) cpSync(src, join(target, d), { recursive: true });
  }
  const store = loadStore(target);
  const artifacts = [...store.nodes.values()]
    .filter((n) => n.type === "artifact")
    .map((n) => {
      const p = n.type === "artifact" ? n.path : "";
      const abs = join(target, p);
      const present = existsSync(abs);
      return { path: p, sha256: present ? sha256(readFileSync(abs)) : (n.type === "artifact" ? n.sha256 : ""), present };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: Manifest = {
    format: "whitesnake-export/1",
    store_id: config.id,
    name: config.name,
    exported_at: nowIso(),
    head_commit: head,
    history_included: isGitRepo(root) ? opts.history : false,
    tool_version: toolVersion(),
    skill_sha256: skillSha(),
    nodes: store.nodes.size,
    files: hashTree(target),
    artifacts,
    excluded: [...(isGitRepo(root) && !opts.history ? ["git history before the exported commit"] : []), ...artifacts.filter((a) => !a.present).map((a) => `artifact ${a.path}`), ".whitesnake/ (index, hook log, transcripts)"],
    requirements: { node: ">=22.13", harnesses: ["claude", "codex"] },
  };
  writeText(join(target, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  buildIndex(target);
  writeText(join(target, "review.html"), renderReview(target));
  return manifest;
}

export interface CheckReport {
  manifest_found: boolean;
  exported_at: string | null;
  history_included: boolean | null;
  mismatched: string[];
  missing: string[];
  extra: string[];
  artifacts_missing: string[];
  validation_errors: number;
  validation_warnings: number;
  nodes: number;
  procedures: ProcedureCheck | null;
  ok: boolean;
}

/**
 * First-open check of an imported store: manifest integrity, artifacts, validation, index, and (unless disabled)
 * the regression cases of every usable code procedure on this machine; procedures that break here are suspended.
 */
export function checkStore(root: string, opts: { runProcedures?: boolean } = {}): CheckReport {
  const manifestPath = join(root, MANIFEST_FILE);
  const report: CheckReport = { manifest_found: false, exported_at: null, history_included: null, mismatched: [], missing: [], extra: [], artifacts_missing: [], validation_errors: 0, validation_warnings: 0, nodes: 0, procedures: null, ok: false };
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    report.manifest_found = true;
    report.exported_at = m.exported_at;
    report.history_included = m.history_included;
    const now = hashTree(root);
    for (const [f, h] of Object.entries(m.files)) {
      if (!(f in now)) report.missing.push(f);
      else if (now[f] !== h) report.mismatched.push(f);
    }
    for (const f of Object.keys(now)) if (!(f in m.files)) report.extra.push(f);
  }
  const store = loadStore(root);
  report.nodes = store.nodes.size;
  for (const n of store.nodes.values()) {
    if (n.type === "artifact" && !existsSync(join(root, n.path))) report.artifacts_missing.push(n.path);
  }
  const issues = validateStore(store);
  // Missing artifacts are reported separately: an export may legitimately exclude bulky files.
  report.validation_errors = errorsOf(issues).filter((i) => i.code !== "E_ARTIFACT_MISSING").length;
  report.validation_warnings = warningsOf(issues).length;
  if (opts.runProcedures !== false && report.validation_errors === 0) {
    report.procedures = checkProcedures(store, { suspend: true });
    buildIndex(root, loadStore(root));
  } else {
    buildIndex(root, store);
  }
  report.ok = report.mismatched.length === 0 && report.missing.length === 0 && report.validation_errors === 0;
  return report;
}

export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
