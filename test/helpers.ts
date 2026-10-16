import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Compiled tests live in dist/test; the repo root is two levels up. */
export const REPO_ROOT = resolve(here, "..", "..");
export const CLI = join(REPO_ROOT, "dist", "src", "cli.js");
export const TOY_STORE = join(REPO_ROOT, "examples", "toy-store");
export const FIXTURES = join(REPO_ROOT, "test", "fixtures");

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

export function runCli(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): CliResult {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    input: opts.input,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  let json: unknown = null;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = null;
    }
  }
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json };
}

/** Fresh copy of the toy store in a temp directory; call the returned cleanup when done. */
export function tempToy(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "whitesnake-toy-"));
  cpSync(TOY_STORE, dir, { recursive: true });
  rmSync(join(dir, ".whitesnake"), { recursive: true, force: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
