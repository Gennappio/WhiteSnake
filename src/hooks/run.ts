import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildIndex } from "../index/db.js";
import { frontier, renderFrontier } from "../index/queries.js";
import { ensureIndex } from "../index/db.js";
import { ingestClaudeLogFile } from "../ingest/claude.js";
import { sessionIdFor, turnIdFor } from "../schema/ids.js";
import type { Turn } from "../schema/nodes.js";
import { findStoreRoot, loadConfig } from "../store/config.js";
import { loadStore, writeNodeFile } from "../store/files.js";
import { CURRENT_TURN_FILE } from "../store/ops.js";
import { validateStore } from "../store/validate.js";
import { appendText, collapseWs, nowIso, sha256, truncate, writeText } from "../util.js";

/** Hook payload shared by Claude Code and Codex (field names follow the Claude Code contract). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
  stop_hook_active?: boolean;
  harness?: "claude" | "codex";
}

export interface HookOutput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "read_file", "grep", "glob"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "write_file", "edit_file", "apply_patch"]);

function log(root: string, entry: Record<string, unknown>): void {
  appendText(join(root, ".autosoft", "hooks.log"), `${JSON.stringify({ ts: nowIso(), ...entry })}\n`);
}

function pathsOf(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const key of ["file_path", "path", "notebook_path", "pattern"]) {
    const v = input[key];
    if (typeof v === "string") out.push(v);
  }
  const edits = input["edits"];
  if (Array.isArray(edits)) for (const e of edits) if (e && typeof e === "object" && typeof (e as { file_path?: unknown }).file_path === "string") out.push((e as { file_path: string }).file_path);
  return out;
}

function touchesKnowledge(root: string, cwd: string, paths: string[]): boolean {
  const kdir = join(root, "knowledge");
  return paths.some((p) => {
    const abs = resolve(cwd, p);
    const rel = relative(kdir, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function gitCommit(root: string, message: string): string | null {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    if (!status.trim()) return "clean";
    execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-q", "-m", message], { stdio: "ignore" });
    return "committed";
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export function runHook(event: string, input: HookInput): HookOutput {
  const cwd = input.cwd ?? process.cwd();
  const root = findStoreRoot(cwd);
  if (!root) return { exitCode: 0 };
  const harness = input.harness ?? "claude";
  try {
    switch (event) {
      case "SessionStart": {
        buildIndex(root);
        const db = ensureIndex(root);
        const f = frontier(db);
        db.close();
        const cfg = loadConfig(root);
        log(root, { event, session: input.session_id, source: input.source });
        const text = [
          `AutoSoft store "${cfg.name}" (${cfg.id}). Mandate: ${cfg.mandate || "not stated"}.`,
          "Before deciding, consult precedents with `autosoft precedent <text>`; explain results with `autosoft why <id|unit/field>`.",
          "Record decisions and evidence only through `autosoft add` / `autosoft set` / `autosoft link`; never edit files under knowledge/ directly.",
          "",
          renderFrontier(f),
        ].join("\n");
        return { exitCode: 0, stdout: text };
      }
      case "UserPromptSubmit": {
        const native = input.session_id ?? "unknown";
        const sid = sessionIdFor(harness, native);
        const store = loadStore(root);
        const existingTurns = [...store.nodes.values()].filter((n) => n.type === "turn" && n.session === sid).length;
        const index = existingTurns + 1;
        const prompt = (input.prompt ?? "").trim();
        const id = turnIdFor(harness, native, index);
        const now = nowIso();
        if (!store.nodes.has(sid)) {
          writeNodeFile(
            root,
            {
              id: sid,
              title: `${harness === "codex" ? "Codex" : "Claude Code"} session ${native.slice(0, 8)}`,
              created: now,
              created_by: `hook:${harness}`,
              type: "session",
              harness,
              native_id: native,
              cwd,
              git_branch: null,
              log_path: input.transcript_path ?? null,
              model: null,
              started: now,
              ended: null,
            },
            "",
          );
        }
        const turn: Turn = {
          id,
          title: `Turn ${index}: ${truncate(collapseWs(prompt), 60) || "(empty prompt)"}`,
          created: now,
          created_by: `hook:${harness}`,
          type: "turn",
          session: sid,
          index,
          native_id: null,
          prompt_excerpt: truncate(collapseWs(prompt), 200),
          prompt_hash: sha256(prompt),
          timestamp: now,
        };
        writeNodeFile(root, turn, prompt);
        writeText(join(root, CURRENT_TURN_FILE), `${id}\n`);
        log(root, { event, session: input.session_id, turn: id });
        return { exitCode: 0, stdout: `Current AutoSoft turn: ${id}. Records created during this turn carry caused_by=${id} automatically.` };
      }
      case "PreToolUse": {
        const tool = input.tool_name ?? "";
        const paths = pathsOf(input.tool_input);
        const inKnowledge = touchesKnowledge(root, cwd, paths);
        if (inKnowledge && WRITE_TOOLS.has(tool)) {
          log(root, { event, tool, decision: "deny", paths });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  "Files under knowledge/ are written only through the CLI so they stay valid: use `autosoft add <type> --json ...`, `autosoft set <id> --json ...` or `autosoft link <id> <rel> <ids...>`.",
              },
            }),
          };
        }
        if (inKnowledge && READ_TOOLS.has(tool)) {
          log(root, { event, tool, decision: "allow+nudge", paths });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                additionalContext:
                  "Reading knowledge/ files directly is allowed but rarely needed: `autosoft precedent <text>`, `autosoft why <id>`, `autosoft get <id>` and `autosoft frontier` answer most questions faster and with resolved links.",
              },
            }),
          };
        }
        log(root, { event, tool, decision: "allow" });
        return { exitCode: 0 };
      }
      case "PostToolUse": {
        const tool = input.tool_name ?? "";
        const cmd = typeof input.tool_input?.["command"] === "string" ? (input.tool_input["command"] as string) : undefined;
        log(root, { event, tool, command: cmd?.startsWith("autosoft") || cmd?.includes("cli.js") ? truncate(cmd, 200) : undefined });
        return { exitCode: 0 };
      }
      case "Stop":
      case "SessionEnd":
      case "PreCompact": {
        let ingested: unknown = null;
        if (input.transcript_path && harness === "claude") ingested = ingestClaudeLogFile(root, input.transcript_path);
        buildIndex(root);
        const issues = validateStore(loadStore(root));
        const commit = gitCommit(root, `store: ${event.toLowerCase()} ${(input.session_id ?? "").slice(0, 8)}`.trim());
        log(root, { event, session: input.session_id, ingested, validation_errors: issues.length, commit });
        if (issues.length) {
          return { exitCode: 0, stdout: JSON.stringify({ systemMessage: `AutoSoft: ${issues.length} validation issue(s) in the store; run \`autosoft validate\`.` }) };
        }
        return { exitCode: 0 };
      }
      default:
        log(root, { event, note: "unhandled event" });
        return { exitCode: 0 };
    }
  } catch (e) {
    log(root, { event, error: (e as Error).message });
    return { exitCode: 0, stderr: `autosoft hook ${event} failed: ${(e as Error).message}` };
  }
}
