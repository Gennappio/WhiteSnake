import { randomBytes } from "node:crypto";

export const NODE_TYPES = [
  "question",
  "decision",
  "evidence",
  "artifact",
  "procedure",
  "episode",
  "session",
  "turn",
  "template",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const PREFIX: Record<NodeType, string> = {
  question: "q",
  decision: "dec",
  evidence: "ev",
  artifact: "art",
  procedure: "proc",
  episode: "ep",
  session: "ses",
  turn: "turn",
  template: "tpl",
};

const BY_PREFIX: Record<string, NodeType> = Object.fromEntries(
  (Object.entries(PREFIX) as [NodeType, string][]).map(([t, p]) => [p, t]),
);

/** Directory under knowledge/ for each node type. */
export const TYPE_DIR: Record<NodeType, string> = {
  question: "questions",
  decision: "decisions",
  evidence: "evidence",
  artifact: "artifacts",
  procedure: "procedures",
  episode: "episodes",
  session: "sessions",
  turn: "turns",
  template: "templates",
};

export const DIR_TYPE: Record<string, NodeType> = Object.fromEntries(
  (Object.entries(TYPE_DIR) as [NodeType, string][]).map(([t, d]) => [d, t]),
);

export const HARNESSES = ["claude", "codex", "stub"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Lowercase alphabet without ambiguous letters (i, l, o, u). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function randomSuffix(n = 12): string {
  const bytes = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return s;
}

export function isAuthoredType(type: NodeType): boolean {
  return type !== "session" && type !== "turn";
}

/** New random identifier for an authored node. Sessions and turns derive their ids from native data. */
export function newId(type: NodeType): string {
  if (!isAuthoredType(type)) throw new Error(`${type} ids are derived from native session data, not random`);
  return `${PREFIX[type]}_${randomSuffix()}`;
}

export function sanitizeNative(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-z]/g, "");
}

export function sessionIdFor(harness: Harness, nativeSessionId: string): string {
  return `ses_${harness}_${sanitizeNative(nativeSessionId)}`;
}

export function turnIdFor(harness: Harness, nativeSessionId: string, index: number): string {
  return `turn_${harness}_${sanitizeNative(nativeSessionId)}_${String(index).padStart(4, "0")}`;
}

export const AUTHORED_ID_RE = /^(q|dec|ev|art|proc|ep|tpl)_[0-9a-z]{12}$/;
export const SESSION_ID_RE = /^ses_(claude|codex|stub)_[0-9a-z]+$/;
export const TURN_ID_RE = /^turn_(claude|codex|stub)_[0-9a-z]+_[0-9]{4}$/;

export function typeOfId(id: string): NodeType | null {
  const prefix = id.split("_")[0] ?? "";
  return BY_PREFIX[prefix] ?? null;
}

export function isValidId(id: string, type?: NodeType): boolean {
  const t = typeOfId(id);
  if (!t) return false;
  if (type && t !== type) return false;
  if (t === "session") return SESSION_ID_RE.test(id);
  if (t === "turn") return TURN_ID_RE.test(id);
  return AUTHORED_ID_RE.test(id);
}
