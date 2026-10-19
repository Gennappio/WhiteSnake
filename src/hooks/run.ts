import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildIndex } from "../index/db.js";
import { frontier, renderFrontier } from "../index/queries.js";
import { ensureIndex } from "../index/db.js";
import { ingestLogFile, lastAssistantText } from "../ingest/index.js";
import { decisionIdsIn, markShown } from "../lifecycle/shown.js";
import { sessionIdFor, turnIdFor } from "../schema/ids.js";
import type { Turn } from "../schema/nodes.js";
import { findStoreRoot, loadConfig } from "../store/config.js";
import { loadStore, writeNodeFile } from "../store/files.js";
import { checkJournal, ensureSnapshot } from "../store/journal.js";
import { CURRENT_TURN_FILE, currentTurn } from "../store/ops.js";
import { validateStore } from "../store/validate.js";
import { appendText, collapseWs, nowIso, sha256, truncate, writeText } from "../util.js";
import { checkStore } from "../handoff.js";

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
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec", "bash"]);

/** Commands that create, modify or delete files under knowledge/ without going through the CLI. */
const SHELL_WRITE_RE = /(^|[^<])>{1,2}\s*\S*knowledge\/|\b(tee|cp|mv|rm|rmdir|touch|truncate|install|mkdir)\b[^;&|]*[\s'"=\/]knowledge(\/|\b)|\b(sed|perl)\s+-[a-zA-Z]*i[^;&|]*[\s'"=\/]knowledge(\/|\b)/;
/** A redirection of standard output into knowledge/: a hand-written file even when the program is the CLI. */
const REDIRECT_INTO_KNOWLEDGE_RE = /(^|[^<])>{1,2}\s*\S*knowledge\//;
/** Any mention of the knowledge directory as a path token, with or without a trailing slash. */
const KNOWLEDGE_MENTION_RE = /(^|[\s'"=\/])knowledge(\/|\b)/;
/** Brackets, subshell openers and variable assignments that may precede the program name of a simple command. */
const SEGMENT_PREFIX_RE = /^(?:[\s({]+|\$\(\s*|[A-Za-z_][A-Za-z0-9_]*=\$\(\s*|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$[A-Za-z_{]\S*|[^\s$]\S*|)\s+)+/;

/**
 * Split a command line into simple commands at `;`, `|`, `||`, `&&`, `&` and newlines, outside quotes.
 * Each simple command is judged on its own: a CLI call in one segment does not excuse a hand write in the next,
 * and text quoted inside an argument is never read as shell syntax.
 */
export function shellSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      if (current.trim()) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

/** True when the program of a simple command is the whitesnake CLI: `whitesnake …`, `path/to/whitesnake …` or `node … cli.js …`. */
export function isCliSegment(segment: string): boolean {
  const s = segment.replace(SEGMENT_PREFIX_RE, "");
  return /^(?:\S*\/)?whitesnake(?:\s|$)/.test(s) || /^(?:\S*\/)?node(?:js)?\s+(?:--?[\w-]+(?:=\S*)?\s+)*\S*cli\.js(?:\s|$)/.test(s);
}

/** Quoted strings removed, so text passed as an argument is not mistaken for shell syntax. */
function withoutQuoted(segment: string): string {
  return segment.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "");
}

/** The simple commands of a command line that write under knowledge/ by hand. */
export function handWriteSegments(command: string): string[] {
  return shellSegments(command).filter((seg) => (isCliSegment(seg) ? REDIRECT_INTO_KNOWLEDGE_RE.test(withoutQuoted(seg)) : SHELL_WRITE_RE.test(seg)));
}

function shellCommandOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const c = input["command"] ?? input["cmd"];
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return null;
}

/** Paths named by an apply_patch style input (*** Add File: path). */
function patchPathsOf(input: Record<string, unknown> | undefined): string[] {
  const patch = input?.["patch"] ?? input?.["input"];
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm)].map((m) => (m[1] ?? "").trim());
}

function log(root: string, entry: Record<string, unknown>): void {
  appendText(join(root, ".whitesnake", "hooks.log"), `${JSON.stringify({ ts: nowIso(), ...entry })}\n`);
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
        let firstOpen = "";
        if (existsSync(join(root, "manifest.json")) && !existsSync(join(root, ".whitesnake", "checked"))) {
          const rep = checkStore(root, { runProcedures: true });
          writeText(join(root, ".whitesnake", "checked"), nowIso());
          const procs = rep.procedures ? `${rep.procedures.checked.length} procedure(s) re-run, ${rep.procedures.suspended.length} suspended for this platform` : "procedures not checked";
          firstOpen = `First open of an imported store: ${rep.ok ? "integrity ok" : `PROBLEMS (${rep.mismatched.length} mismatched, ${rep.missing.length} missing, ${rep.validation_errors} validation errors)`}; ${procs}.`;
          log(root, { event, first_open: rep });
        }
        buildIndex(root);
        const db = ensureIndex(root);
        const f = frontier(db);
        db.close();
        const cfg = loadConfig(root);
        const baseline = ensureSnapshot(root);
        log(root, { event, session: input.session_id, source: input.source, journal: baseline ? "baseline taken" : "baseline kept" });
        const text = [
          `WhiteSnake store "${cfg.name}" (${cfg.id}). Mandate: ${cfg.mandate || "not stated"}.`,
          firstOpen,
          "Before deciding, consult precedents with `whitesnake precedent <text>`; explain results with `whitesnake why <id|unit/field>`.",
          "Record decisions and evidence only through `whitesnake add` / `whitesnake set` / `whitesnake link`; never edit files under knowledge/ directly.",
          "",
          renderFrontier(f),
        ]
          .filter(Boolean)
          .join("\n");
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
        return { exitCode: 0, stdout: `Current WhiteSnake turn: ${id}. Records created during this turn carry caused_by=${id} automatically.` };
      }
      case "PreToolUse": {
        const tool = input.tool_name ?? "";
        const paths = [...pathsOf(input.tool_input), ...patchPathsOf(input.tool_input)];
        const inKnowledge = touchesKnowledge(root, cwd, paths);
        const command = SHELL_TOOLS.has(tool) ? shellCommandOf(input.tool_input) : null;
        const handWrites = command ? handWriteSegments(command) : [];
        if (command && handWrites.length) {
          log(root, { event, tool, decision: "deny", command: truncate(command, 200), segment: truncate(handWrites[0]!.trim(), 120) });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  "Shell commands must not create or modify files under knowledge/: use `whitesnake add`, `whitesnake set` or `whitesnake link` so the record is validated.",
              },
            }),
          };
        }
        if (command && shellSegments(command).some((seg) => !isCliSegment(seg) && KNOWLEDGE_MENTION_RE.test(seg))) {
          log(root, { event, tool, decision: "allow+nudge", command: truncate(command, 200) });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                additionalContext: "Reading knowledge/ files from the shell is allowed, but `whitesnake get <id>`, `whitesnake why <id>` and `whitesnake precedent <text>` give the same information with resolved links.",
              },
            }),
          };
        }
        if (inKnowledge && WRITE_TOOLS.has(tool)) {
          log(root, { event, tool, decision: "deny", paths });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  "Files under knowledge/ are written only through the CLI so they stay valid: use `whitesnake add <type> --json ...`, `whitesnake set <id> --json ...` or `whitesnake link <id> <rel> <ids...>`.",
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
                  "Reading knowledge/ files directly is allowed but rarely needed: `whitesnake precedent <text>`, `whitesnake why <id>`, `whitesnake get <id>` and `whitesnake frontier` answer most questions faster and with resolved links.",
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
        log(root, { event, tool, command: cmd?.startsWith("whitesnake") || cmd?.includes("cli.js") ? truncate(cmd, 200) : undefined });
        return { exitCode: 0 };
      }
      case "Stop":
      case "SessionEnd":
      case "PreCompact": {
        let ingested: unknown = null;
        let shown: unknown = null;
        if (input.transcript_path) {
          ingested = ingestLogFile(root, input.transcript_path);
          // Decisions the agent listed in its final message count as shown to the researcher.
          const finalText = lastAssistantText(input.transcript_path);
          const ids = finalText ? decisionIdsIn(finalText) : [];
          if (ids.length) shown = markShown(loadStore(root), ids, currentTurn(root));
        }
        buildIndex(root);
        // By result, not by command: files under knowledge/ that changed since the last check without a CLI receipt.
        const journal = checkJournal(root);
        const directWrites = journal.direct.map((d) => `${d.path} ${d.change}`);
        const issues = validateStore(loadStore(root)).filter((i) => i.severity !== "warning");
        const commit = gitCommit(root, `store: ${event.toLowerCase()} ${(input.session_id ?? "").slice(0, 8)}`.trim());
        log(root, { event, session: input.session_id, ingested, shown, validation_errors: issues.length, direct_writes: directWrites, journal_baseline: journal.baseline, commit });
        const notes: string[] = [];
        if (directWrites.length) {
          const listed = directWrites.slice(0, 5).join(", ") + (directWrites.length > 5 ? `, and ${directWrites.length - 5} more` : "");
          notes.push(`${directWrites.length} file(s) under knowledge/ changed outside the CLI since the last check (${listed}); they skipped validation at write time. Redo them with \`whitesnake add\` or \`whitesnake set\`, then run \`whitesnake validate\`.`);
        }
        if (issues.length) notes.push(`${issues.length} validation issue(s) in the store; run \`whitesnake validate\`.`);
        if (notes.length) return { exitCode: 0, stdout: JSON.stringify({ systemMessage: `WhiteSnake: ${notes.join(" ")}` }) };
        return { exitCode: 0 };
      }
      default:
        log(root, { event, note: "unhandled event" });
        return { exitCode: 0 };
    }
  } catch (e) {
    log(root, { event, error: (e as Error).message });
    return { exitCode: 0, stderr: `whitesnake hook ${event} failed: ${(e as Error).message}` };
  }
}
