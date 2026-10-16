import { existsSync } from "node:fs";
import { readText } from "../util.js";
import { ingestParsed, parseClaudeLog, type IngestResult } from "./claude.js";
import { isCodexLog, parseCodexLog } from "./codex.js";

export type LogFormat = "claude" | "codex" | "unknown";

export function detectLogFormat(text: string): LogFormat {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  if (isCodexLog(first)) return "codex";
  try {
    const o = JSON.parse(first) as { sessionId?: unknown; type?: unknown };
    if (typeof o.sessionId === "string" || o.type === "user" || o.type === "assistant" || o.type === "summary") return "claude";
  } catch {
    // fall through
  }
  return /"sessionId":/.test(text.slice(0, 20000)) ? "claude" : "unknown";
}

/** Ingest a native session log of either harness, detecting the format from its content. */
export function ingestLogFile(root: string, logPath: string): (IngestResult & { format: LogFormat }) | null {
  if (!existsSync(logPath)) return null;
  const text = readText(logPath);
  const format = detectLogFormat(text);
  const parsed = format === "codex" ? parseCodexLog(text, logPath) : format === "claude" ? parseClaudeLog(text, logPath) : null;
  if (!parsed) return null;
  return { ...ingestParsed(root, parsed), format };
}

/** The agent's last message in a native log: where it lists the decisions it presented to the researcher. */
export function lastAssistantText(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  const text = readText(logPath);
  const format = detectLogFormat(text);
  let last: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (format === "claude") {
      const msg = o["message"] as { content?: unknown } | undefined;
      if (o["type"] === "assistant" && !o["isSidechain"] && Array.isArray(msg?.content)) {
        const t = (msg!.content as { type?: string; text?: string }[]).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n").trim();
        if (t) last = t;
      }
    } else if (format === "codex") {
      const p = (o["payload"] ?? {}) as Record<string, unknown>;
      if (o["type"] === "event_msg" && p["type"] === "task_complete" && typeof p["last_agent_message"] === "string") last = p["last_agent_message"] as string;
      else if (o["type"] === "response_item" && p["type"] === "message" && p["role"] === "assistant" && Array.isArray(p["content"])) {
        const t = (p["content"] as { type?: string; text?: string }[]).filter((b) => typeof b.text === "string").map((b) => b.text as string).join("\n").trim();
        if (t) last = t;
      }
    }
  }
  return last;
}
