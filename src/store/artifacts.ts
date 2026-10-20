/**
 * Artifacts are the sources every locator points into (corpus files, PDFs, outputs of delegations). Each is
 * registered with its sha256. This module compares the files on disk with those hashes: a source that changed since
 * registration makes every excerpt and locator into it suspect, so it is an error, not a note.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LoadedStore, ValidationIssue } from "./files.js";
import { readText, sha256, writeText } from "../util.js";

/** `cached` trusts a hash computed earlier for a file with the same size and mtime; `full` re-reads every file. */
export type ArtifactCheckMode = "cached" | "full";

const CACHE_FILE = ".whitesnake/artifact-hashes.json";

interface CacheEntry {
  mtime: number;
  size: number;
  sha256: string;
}

export function artifactIssues(store: LoadedStore, mode: ArtifactCheckMode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cachePath = join(store.root, CACHE_FILE);
  let cache: Record<string, CacheEntry> = {};
  if (existsSync(cachePath)) {
    try {
      cache = JSON.parse(readText(cachePath)) as Record<string, CacheEntry>;
    } catch {
      cache = {};
    }
  }
  let dirty = false;
  for (const node of store.nodes.values()) {
    if (node.type !== "artifact") continue;
    const file = store.paths.get(node.id);
    const abs = join(store.root, node.path);
    if (!existsSync(abs)) {
      issues.push({ code: "E_ARTIFACT_MISSING", id: node.id, file, path: "path", message: `${node.id} refers to ${node.path}, which does not exist` });
      continue;
    }
    let hash: string;
    try {
      const st = statSync(abs);
      const entry = cache[node.path];
      if (mode === "cached" && entry && entry.mtime === st.mtimeMs && entry.size === st.size) {
        hash = entry.sha256;
      } else {
        hash = sha256(readFileSync(abs));
        cache[node.path] = { mtime: st.mtimeMs, size: st.size, sha256: hash };
        dirty = true;
      }
    } catch (e) {
      issues.push({ code: "E_ARTIFACT_MISSING", id: node.id, file, path: "path", message: `${node.id} refers to ${node.path}, which cannot be read: ${(e as Error).message}` });
      continue;
    }
    if (hash !== node.sha256) {
      issues.push({
        code: "E_ARTIFACT_HASH",
        id: node.id,
        file,
        path: "sha256",
        message: `${node.id}: ${node.path} has sha256 ${hash.slice(0, 12)}… on disk but ${node.sha256.slice(0, 12)}… was registered; the source changed since registration, so every locator into it is suspect. Restore the file, or register the new version as a new artifact.`,
      });
    }
  }
  if (dirty) {
    try {
      writeText(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    } catch {
      // the cache only saves time; validation does not depend on it
    }
  }
  return issues;
}
