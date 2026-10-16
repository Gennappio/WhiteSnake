import { existsSync } from "node:fs";
import { sessionIdFor, turnIdFor } from "../schema/ids.js";
import type { Session, Turn } from "../schema/nodes.js";
import { collapseWs, readText, sha256, truncate } from "../util.js";
import { ingestParsed, ownText, type IngestResult, type ParsedLog } from "./claude.js";

/**
 * Codex rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): one JSON record per line with
 * `timestamp`, `ordinal`, `type` and `payload`. User prompts appear as `response_item/message` records with
 * role `user` (content blocks of type `input_text`), or in some versions as `event_msg/user_message`.
 * Each user turn is preceded by `event_msg/task_started` carrying the native `turn_id`.
 */
interface CodexRecord {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

export function isCodexLog(firstLine: string): boolean {
  try {
    const o = JSON.parse(firstLine) as CodexRecord;
    return o.type === "session_meta" || (typeof o.type === "string" && "payload" in o && typeof o.ordinal === "number");
  } catch {
    return false;
  }
}

function userTextOf(payload: Record<string, unknown>): string | null {
  const content = payload["content"];
  if (typeof payload["message"] === "string") return ownText([payload["message"]]);
  if (!Array.isArray(content)) return null;
  const texts = (content as { type?: string; text?: string }[])
    .filter((b) => (b.type === "input_text" || b.type === "text") && typeof b.text === "string")
    .map((b) => b.text as string);
  return ownText(texts);
}

export function parseCodexLog(text: string, logPath: string | null): ParsedLog | null {
  const records: CodexRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as CodexRecord);
    } catch {
      // partial trailing line
    }
  }
  const meta = records.find((r) => r.type === "session_meta")?.payload;
  const native = (meta?.["session_id"] ?? meta?.["id"]) as string | undefined;
  if (!native) return null;
  const started = (meta?.["timestamp"] as string | undefined) ?? records[0]?.timestamp ?? new Date(0).toISOString();
  const timestamps = records.map((r) => r.timestamp).filter((t): t is string => typeof t === "string");
  const ended = timestamps[timestamps.length - 1] ?? started;
  const turnContext = records.find((r) => r.type === "turn_context")?.payload;
  const model = typeof turnContext?.["model"] === "string" ? (turnContext["model"] as string) : null;

  const sid = sessionIdFor("codex", native);
  const session: Session = {
    id: sid,
    title: `Codex session ${native.slice(0, 8)}`,
    created: started,
    created_by: "ingest:codex",
    type: "session",
    harness: "codex",
    native_id: native,
    cwd: (meta?.["cwd"] as string | undefined) ?? "",
    git_branch: null,
    log_path: logPath,
    model,
    started,
    ended,
  };

  const turns: Turn[] = [];
  const bodies = new Map<string, string>();
  let index = 0;
  let currentTurnId: string | null = null;
  let lastPromptKey: string | null = null;
  for (const r of records) {
    const p = r.payload ?? {};
    if (r.type === "event_msg" && p["type"] === "task_started" && typeof p["turn_id"] === "string") {
      currentTurnId = p["turn_id"] as string;
      continue;
    }
    const isUserMessage = (r.type === "response_item" && p["type"] === "message" && p["role"] === "user") || (r.type === "event_msg" && p["type"] === "user_message");
    if (!isUserMessage) continue;
    const prompt = userTextOf(p);
    if (!prompt) continue;
    const key = `${currentTurnId ?? ""}:${sha256(prompt)}`;
    if (key === lastPromptKey) continue; // the same prompt echoed as event and as response item
    lastPromptKey = key;
    index++;
    const id = turnIdFor("codex", native, index);
    const ts = r.timestamp ?? started;
    turns.push({
      id,
      title: `Turn ${index}: ${truncate(collapseWs(prompt), 60)}`,
      created: ts,
      created_by: "ingest:codex",
      type: "turn",
      session: sid,
      index,
      native_id: currentTurnId,
      prompt_excerpt: truncate(collapseWs(prompt), 200),
      prompt_hash: sha256(prompt),
      timestamp: ts,
    });
    bodies.set(id, prompt);
  }
  return { session, turns, bodies };
}

export function ingestCodexLogFile(root: string, logPath: string): IngestResult | null {
  if (!existsSync(logPath)) return null;
  const parsed = parseCodexLog(readText(logPath), logPath);
  if (!parsed) return null;
  return ingestParsed(root, parsed);
}
