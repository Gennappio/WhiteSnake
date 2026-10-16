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
