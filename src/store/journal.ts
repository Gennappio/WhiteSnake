/**
 * Write journal: receipts for every file the CLI writes or removes under knowledge/, plus a snapshot of the tree
 * taken at the last check. The PreToolUse hook can only refuse the hand writes it recognises in a command line;
 * this module catches the rest by result. At the end of a turn, every file under knowledge/ that differs from the
 * snapshot and has no receipt for exactly its current content was written outside the CLI, however it was written.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { appendText, nowIso, readText, sha256, walkFiles, writeText } from "../util.js";

export const JOURNAL_FILE = ".whitesnake/writes.jsonl";
export const SNAPSHOT_FILE = ".whitesnake/knowledge-snapshot.json";

interface Receipt {
  ts: string;
  op: "write" | "delete";
  path: string;
  hash: string | null;
}

export interface DirectWrite {
  path: string;
  change: "added" | "modified" | "deleted";
}

export interface JournalCheck {
  /** True when no snapshot existed yet: the current tree becomes the baseline and nothing is reported. */
  baseline: boolean;
  files: number;
  receipts: number;
  direct: DirectWrite[];
}

function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** The CLI wrote `text` to `absPath`, a file under knowledge/. */
export function recordWrite(root: string, absPath: string, text: string): void {
  appendText(join(root, JOURNAL_FILE), `${JSON.stringify({ ts: nowIso(), op: "write", path: relPath(root, absPath), hash: sha256(text) } satisfies Receipt)}\n`);
}

/** The CLI removed `absPath`, a file under knowledge/ (gc sweep). */
export function recordDelete(root: string, absPath: string): void {
  appendText(join(root, JOURNAL_FILE), `${JSON.stringify({ ts: nowIso(), op: "delete", path: relPath(root, absPath), hash: null } satisfies Receipt)}\n`);
}

function readReceipts(root: string): Map<string, Receipt> {
  const out = new Map<string, Receipt>();
  const p = join(root, JOURNAL_FILE);
  if (!existsSync(p)) return out;
  for (const line of readText(p).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Receipt;
      out.set(r.path, r);
    } catch {
      // a torn line from an interrupted write: ignore it
    }
  }
  return out;
}

/** Content hashes of every file under knowledge/, keyed by path relative to the store root. */
export function knowledgeTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = join(root, "knowledge");
  if (!existsSync(dir)) return out;
  for (const f of walkFiles(dir)) {
    if (basename(f) === ".DS_Store") continue;
    out[relPath(root, f)] = sha256(readFileSync(f));
  }
  return out;
}

function readSnapshot(root: string): Record<string, string> | null {
  const p = join(root, SNAPSHOT_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readText(p)) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Make the current tree the baseline and start a fresh receipt book. */
export function writeSnapshot(root: string, tree: Record<string, string> = knowledgeTree(root)): void {
  writeText(join(root, SNAPSHOT_FILE), `${JSON.stringify(tree, null, 2)}\n`);
  writeText(join(root, JOURNAL_FILE), "");
}

/** Take the baseline when there is none yet (session start). Returns true when it was taken now. */
export function ensureSnapshot(root: string): boolean {
  if (existsSync(join(root, SNAPSHOT_FILE))) return false;
  writeSnapshot(root);
  return true;
}

/**
 * Compare the tree with the last snapshot and the receipts, then make the current tree the new baseline, so each
 * change is reported once. A changed file with a receipt for exactly its current content was written by the CLI.
 */
export function checkJournal(root: string): JournalCheck {
  const snapshot = readSnapshot(root);
  const tree = knowledgeTree(root);
  const receipts = readReceipts(root);
  const direct: DirectWrite[] = [];
  if (snapshot) {
    for (const [path, hash] of Object.entries(tree)) {
      if (snapshot[path] === hash) continue;
      const r = receipts.get(path);
      if (r && r.op === "write" && r.hash === hash) continue;
      direct.push({ path, change: path in snapshot ? "modified" : "added" });
    }
    for (const path of Object.keys(snapshot)) {
      if (path in tree) continue;
      if (receipts.get(path)?.op === "delete") continue;
      direct.push({ path, change: "deleted" });
    }
  }
  writeSnapshot(root, tree);
  return { baseline: snapshot === null, files: Object.keys(tree).length, receipts: receipts.size, direct: direct.sort((a, b) => a.path.localeCompare(b.path)) };
}
