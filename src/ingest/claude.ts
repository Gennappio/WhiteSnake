import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionIdFor, turnIdFor } from "../schema/ids.js";
import type { Session, Turn } from "../schema/nodes.js";
import { loadStore, writeNodeFile } from "../store/files.js";
import { collapseWs, readText, sha256, truncate } from "../util.js";

export interface ParsedLog {
  session: Session;
  turns: Turn[];
  bodies: Map<string, string>;
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; model?: string; content?: unknown };
}

/** Text blocks that are entirely wrapped in a tag (IDE context, system reminders) are not the user's words. */
const TAG_WRAPPED_RE = /^\s*<([a-zA-Z_][\w-]*)\b[^>]*>[\s\S]*<\/\1>\s*$/;

export function promptTextOf(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const blocks = content as { type?: string; text?: string }[];
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  if (!texts.length) return null;
  const own = texts.filter((t) => !TAG_WRAPPED_RE.test(t));
  const joined = (own.length ? own : texts).join("\n").trim();
  return joined || null;
}

/** Claude Code stores transcripts under ~/.claude/projects/<cwd slug>/<session id>.jsonl. */
export function claudeLogPath(sessionId: string, cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    real = cwd;
  }
  const slug = real.replace(/[^A-Za-z0-9-]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

export function parseClaudeLog(text: string, logPath: string | null): ParsedLog | null {
  const records: ClaudeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ClaudeRecord);
    } catch {
      // partial trailing line while the session is still being written
    }
  }
  const main = records.filter((r) => (r.type === "user" || r.type === "assistant") && !r.isSidechain);
  const first = main.find((r) => r.sessionId);
  if (!first?.sessionId) return null;
  const native = first.sessionId;
  const model = main.find((r) => r.type === "assistant" && r.message?.model)?.message?.model ?? null;
  const timestamps = main.map((r) => r.timestamp).filter((t): t is string => typeof t === "string");
  const started = timestamps[0] ?? new Date(0).toISOString();
  const ended = timestamps[timestamps.length - 1] ?? started;

  const sid = sessionIdFor("claude", native);
  const session: Session = {
    id: sid,
    title: `Claude Code session ${native.slice(0, 8)}`,
    created: started,
    created_by: "ingest:claude",
    type: "session",
    harness: "claude",
    native_id: native,
    cwd: first.cwd ?? "",
    git_branch: first.gitBranch ?? null,
    log_path: logPath,
    model,
    started,
    ended,
  };

  const turns: Turn[] = [];
  const bodies = new Map<string, string>();
  let index = 0;
  for (const r of main) {
    if (r.type !== "user" || r.isMeta) continue;
    const prompt = promptTextOf(r.message?.content);
    if (!prompt) continue;
    index++;
    const id = turnIdFor("claude", native, index);
    const excerpt = truncate(collapseWs(prompt), 200);
    turns.push({
      id,
      title: `Turn ${index}: ${truncate(collapseWs(prompt), 60)}`,
      created: r.timestamp ?? started,
      created_by: "ingest:claude",
      type: "turn",
      session: sid,
      index,
      native_id: r.uuid ?? null,
      prompt_excerpt: excerpt,
      prompt_hash: sha256(prompt),
      timestamp: r.timestamp ?? started,
    });
    bodies.set(id, prompt);
  }
  return { session, turns, bodies };
}

export interface IngestResult {
  session: string;
  turns: number;
  written: number;
  warnings: string[];
}

/** Write session and turn nodes; idempotent because ids derive from the native session id and turn index. */
export function ingestParsed(root: string, parsed: ParsedLog): IngestResult {
  const store = loadStore(root);
  const warnings: string[] = [];
  let written = 0;
  const existingSession = store.nodes.get(parsed.session.id);
  if (!existingSession || JSON.stringify(existingSession) !== JSON.stringify(parsed.session)) {
    writeNodeFile(root, parsed.session, "");
    written++;
  }
  for (const turn of parsed.turns) {
    const existing = store.nodes.get(turn.id);
    if (existing && existing.type === "turn") {
      if (existing.prompt_hash !== turn.prompt_hash) {
        warnings.push(`${turn.id} already exists with a different prompt; keeping the stored one (hook-created turn and log disagree)`);
      }
      continue;
    }
    writeNodeFile(root, turn, parsed.bodies.get(turn.id) ?? "");
    written++;
  }
  return { session: parsed.session.id, turns: parsed.turns.length, written, warnings };
}

export function ingestClaudeLogFile(root: string, logPath: string): IngestResult | null {
  if (!existsSync(logPath)) return null;
  const parsed = parseClaudeLog(readText(logPath), logPath);
  if (!parsed) return null;
  return ingestParsed(root, parsed);
}
