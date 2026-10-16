import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1, public readonly details?: unknown) {
    super(message);
  }
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

export function readText(p: string): string {
  return readFileSync(p, "utf8");
}

export function writeText(p: string, s: string): void {
  ensureDir(dirname(p));
  writeFileSync(p, s, "utf8");
}

export function appendText(p: string, s: string): void {
  ensureDir(dirname(p));
  appendFileSync(p, s, "utf8");
}

export function listFiles(dir: string, ext?: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && (!ext || f.endsWith(ext)))
    .sort()
    .map((f) => join(dir, f));
}

export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out.sort();
}

export function fileMtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Body text as stored and hashed: trailing whitespace removed, so files round-trip exactly. */
export function canonicalBody(body: string): string {
  return body.replace(/\s+$/, "");
}
