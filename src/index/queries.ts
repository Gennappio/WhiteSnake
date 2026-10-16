import type { DatabaseSync } from "node:sqlite";
import { EDGE_SPECS } from "../schema/edges.js";
import type { NodeType } from "../schema/ids.js";
import type { Node } from "../schema/nodes.js";
import { collapseWs, truncate } from "../util.js";
import { tokenize } from "./db.js";

export type IndexedNode = Node & { body: string };

export interface NodeRow {
  id: string;
  type: NodeType;
  status: string;
  kind: string;
  title: string;
  created: string;
  caused_by: string | null;
}

function rowToNode(row: { json: string } | undefined): IndexedNode | null {
  return row ? (JSON.parse(row.json) as IndexedNode) : null;
}

export function getNode(db: DatabaseSync, id: string): IndexedNode | null {
  return rowToNode(db.prepare("SELECT json FROM nodes WHERE id = ?").get(id) as { json: string } | undefined);
}

export function listNodes(db: DatabaseSync, filter: { type?: string; status?: string; kind?: string } = {}): NodeRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.kind) {
    where.push("kind = ?");
    params.push(filter.kind);
  }
  const sql = `SELECT id, type, status, kind, title, created, caused_by FROM nodes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
  return db.prepare(sql).all(...params) as unknown as NodeRow[];
}

/**
 * Resolve a reference: a node id, or `unit/field` naming the current annotation decision for that cell
 * (active first, then the most recently created non-superseded one).
 */
export function resolveRef(db: DatabaseSync, ref: string): string | null {
  if (getNode(db, ref)) return ref;
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const unit = ref.slice(0, slash);
  const field = ref.slice(slash + 1);
  const rows = db
    .prepare("SELECT json FROM nodes WHERE type = 'decision' AND kind = 'annotation' ORDER BY created DESC, id")
    .all() as { json: string }[];
  const candidates = rows
    .map((r) => JSON.parse(r.json) as IndexedNode)
    .filter((n) => n.type === "decision" && n.target?.unit === unit && n.target?.field === field);
  const active = candidates.find((n) => n.type === "decision" && n.status === "active");
  const fallback = candidates.find((n) => n.type === "decision" && n.status !== "superseded" && n.status !== "retired");
  return (active ?? fallback ?? candidates[0])?.id ?? null;
}

export interface WhyNode {
  id: string;
  type: NodeType;
  title: string;
  status?: string;
  kind?: string;
  claim?: string;
  value?: unknown;
  locator?: unknown;
  excerpt?: string;
  prompt?: string;
  children: { rel: string; node: WhyNode }[];
  truncated?: boolean;
  shallow?: boolean;
}

/**
 * Which edges `why` follows from each node type. "expand" children are explained in turn;
 * "shallow" children are shown as one-line summaries so the tree stays readable.
 */
const WHY_POLICY: Record<string, { expand: readonly string[]; shallow: readonly string[] }> = {
  decision: { expand: ["data", "warrant", "backing", "rebuttal", "depends_on", "produced_by", "caused_by"], shallow: ["supersedes", "answers"] },
  evidence: { expand: ["locator", "caused_by"], shallow: ["produced_by"] },
  artifact: { expand: [], shallow: ["caused_by"] },
  episode: { expand: ["caused_by"], shallow: ["uses", "parent", "question"] },
  procedure: { expand: ["caused_by"], shallow: ["uses", "promoted_from", "produced_by"] },
  question: { expand: ["caused_by"], shallow: ["raised_in", "answered_by"] },
  turn: { expand: ["session"], shallow: [] },
  session: { expand: [], shallow: [] },
  template: { expand: ["caused_by"], shallow: [] },
};

function summarize(n: IndexedNode): WhyNode {
  const w: WhyNode = { id: n.id, type: n.type, title: n.title, children: [] };
  switch (n.type) {
    case "decision":
      w.status = n.status;
      w.kind = n.kind;
      w.claim = n.claim;
      if (n.target) w.value = n.target.value;
      break;
    case "evidence":
      w.kind = n.kind;
      w.locator = n.locator;
      w.excerpt = truncate(collapseWs(n.body), 240);
      break;
    case "procedure":
      w.status = n.state;
      w.kind = n.resolution;
      break;
    case "episode":
      w.status = n.outcome;
      w.kind = n.resolution;
      break;
    case "question":
      w.status = n.status;
      break;
    case "turn":
      w.prompt = n.prompt_excerpt;
      break;
    default:
      break;
  }
  return w;
}

/**
 * Provenance tree: from a decision down to its evidence and locators, the criterion that licensed it,
 * the episode that produced it and the prompt that caused it. Below the root, prompts are shown shallow.
 */
export function why(db: DatabaseSync, id: string, maxDepth = 6): WhyNode | null {
  const visited = new Set<string>();
  const walk = (nodeId: string, depth: number): WhyNode | null => {
    const n = getNode(db, nodeId);
    if (!n) return null;
    const w = summarize(n);
    if (visited.has(nodeId) || depth >= maxDepth) {
      w.truncated = true;
      return w;
    }
    visited.add(nodeId);
    const policy = WHY_POLICY[n.type] ?? { expand: [], shallow: [] };
    const edges = db.prepare("SELECT rel, dst FROM edges WHERE src = ? ORDER BY rel, dst").all(nodeId) as { rel: string; dst: string }[];
    for (const e of edges) {
      const shallow = policy.shallow.includes(e.rel) || (depth > 0 && e.rel === "caused_by");
      if (shallow) {
        const child = getNode(db, e.dst);
        if (child) w.children.push({ rel: e.rel, node: { ...summarize(child), shallow: true } });
      } else if (policy.expand.includes(e.rel)) {
        const child = walk(e.dst, depth + 1);
        if (child) w.children.push({ rel: e.rel, node: child });
      }
    }
    return w;
  };
  return walk(id, 0);
}

export function renderWhy(w: WhyNode, indent = ""): string {
  const bits: string[] = [`${w.id} (${w.type}${w.kind ? `/${w.kind}` : ""}${w.status ? `, ${w.status}` : ""}) ${w.title}`];
  if (w.claim) bits.push(`${indent}    claim: ${w.claim}`);
  if (w.value !== undefined) bits.push(`${indent}    value: ${JSON.stringify(w.value)}`);
  if (w.locator) bits.push(`${indent}    locator: ${JSON.stringify(w.locator)}`);
  if (w.excerpt) bits.push(`${indent}    excerpt: ${w.excerpt}`);
  if (w.prompt) bits.push(`${indent}    prompt: ${truncate(w.prompt, 160)}`);
  if (w.truncated) bits.push(`${indent}    …`);
  if (w.shallow && w.children.length === 0) bits[0] = `${bits[0]}`;
  const lines = [`${indent}${bits.join("\n")}`];
  for (const c of w.children) lines.push(renderWhy(c.node, `${indent}  `).replace(/^(\s*)/, `$1[${c.rel}] `));
  return lines.join("\n");
}

export interface AffectedRow {
  id: string;
  type: NodeType;
  status: string;
  title: string;
  depth: number;
}

/**
 * Everything that transitively relies on `id`, following only edges flagged `relies` for their source type:
 * decisions citing it as data/warrant/backing/depends_on, episodes that used it, decisions produced by those episodes.
 * A decision's own citations are authoritative: when the changed node is a decision (criterion or choice), a decision
 * reached only through its producing episode is skipped if it declares warrant/backing/depends_on without naming it.
 * Decisions that declare nothing inherit their episode's dependencies.
 */
export function affected(db: DatabaseSync, id: string): AffectedRow[] {
  const root = getNode(db, id);
  if (!root) return [];
  const rootIsDecision = root.type === "decision";
  const incoming = new Map<string, { src: string; rel: string }[]>();
  for (const e of db.prepare("SELECT src, rel, dst FROM edges WHERE relies = 1 ORDER BY src, rel").all() as { src: string; rel: string; dst: string }[]) {
    const list = incoming.get(e.dst) ?? [];
    list.push({ src: e.src, rel: e.rel });
    incoming.set(e.dst, list);
  }
  const depth = new Map<string, number>([[id, 0]]);
  const queue: string[] = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const { src, rel } of incoming.get(cur) ?? []) {
      if (depth.has(src)) continue;
      if (rootIsDecision && rel === "produced_by") {
        const dec = getNode(db, src);
        if (dec && dec.type === "decision") {
          const declared = [...dec.warrant, ...dec.backing, ...dec.depends_on];
          if (declared.length > 0 && !declared.includes(id)) continue;
        }
      }
      depth.set(src, d + 1);
      queue.push(src);
    }
  }
  const rows: AffectedRow[] = [];
  for (const [nid, dd] of depth) {
    if (nid === id) continue;
    const n = db.prepare("SELECT id, type, status, title FROM nodes WHERE id = ?").get(nid) as { id: string; type: NodeType; status: string; title: string } | undefined;
    if (n) rows.push({ ...n, depth: dd });
  }
  return rows.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

export interface PrecedentRow {
  id: string;
  type: NodeType;
  status: string;
  kind: string;
  title: string;
  score: number;
}

const DEFAULT_PRECEDENT_TYPES = ["decision", "procedure", "question", "episode", "template"];

/** Lexical search over the inverted index: word matches weigh 2, trigram matches 1; ties break on id. */
export function precedent(db: DatabaseSync, text: string, opts: { types?: string[]; limit?: number } = {}): PrecedentRow[] {
  const terms = [...tokenize(text).keys()];
  if (!terms.length) return [];
  const types = opts.types?.length ? opts.types : DEFAULT_PRECEDENT_TYPES;
  const limit = opts.limit ?? 10;
  const sql = `
    SELECT n.id, n.type, n.status, n.kind, n.title, SUM(t.weight) AS score
    FROM tokens t JOIN nodes n ON n.id = t.node_id
    WHERE t.term IN (${terms.map(() => "?").join(",")}) AND n.type IN (${types.map(() => "?").join(",")})
    GROUP BY n.id ORDER BY score DESC, n.id LIMIT ?`;
  return db.prepare(sql).all(...terms, ...types, limit) as unknown as PrecedentRow[];
}

export interface Frontier {
  open_questions: NodeRow[];
  proposed_decisions: NodeRow[];
  needs_review: NodeRow[];
  provisional_procedures: NodeRow[];
  suspended_procedures: NodeRow[];
  open_episodes: NodeRow[];
  resolutions: Record<string, number>;
}

export function frontier(db: DatabaseSync): Frontier {
  const resolutions: Record<string, number> = {};
  for (const r of db.prepare("SELECT kind, COUNT(*) AS c FROM nodes WHERE type = 'episode' AND status <> 'open' GROUP BY kind ORDER BY kind").all() as { kind: string; c: number }[]) {
    resolutions[r.kind] = r.c;
  }
  return {
    open_questions: listNodes(db, { type: "question", status: "open" }),
    proposed_decisions: listNodes(db, { type: "decision", status: "proposed" }),
    needs_review: listNodes(db, { type: "decision", status: "needs_review" }),
    provisional_procedures: listNodes(db, { type: "procedure", status: "provisional" }),
    suspended_procedures: listNodes(db, { type: "procedure", status: "suspended" }),
    open_episodes: listNodes(db, { type: "episode", status: "open" }),
    resolutions,
  };
}

export function renderFrontier(f: Frontier): string {
  const section = (name: string, rows: NodeRow[]) => (rows.length ? [`${name} (${rows.length}):`, ...rows.map((r) => `  ${r.id}  ${r.title}`)] : [`${name}: none`]);
  return [
    ...section("Open questions", f.open_questions),
    ...section("Proposed decisions", f.proposed_decisions),
    ...section("Decisions needing review", f.needs_review),
    ...section("Provisional procedures", f.provisional_procedures),
    ...section("Suspended procedures", f.suspended_procedures),
    ...section("Open episodes", f.open_episodes),
    `Closed episodes by resolution: ${Object.entries(f.resolutions).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
  ].join("\n");
}

export interface TimelineTurn {
  turn: string;
  index: number;
  timestamp: string;
  prompt: string;
  caused: { id: string; type: NodeType; title: string; status: string }[];
}

export interface TimelineSession {
  session: string;
  harness: string;
  started: string;
  turns: TimelineTurn[];
}

export function timeline(db: DatabaseSync, sessionId?: string): TimelineSession[] {
  const sessions = (db.prepare(`SELECT json FROM nodes WHERE type = 'session' ${sessionId ? "AND id = ?" : ""} ORDER BY created, id`).all(...(sessionId ? [sessionId] : [])) as { json: string }[])
    .map((r) => JSON.parse(r.json) as IndexedNode)
    .filter((n): n is IndexedNode & { type: "session" } => n.type === "session");
  const out: TimelineSession[] = [];
  for (const s of sessions) {
    const turns = (db.prepare("SELECT json FROM nodes WHERE type = 'turn' ORDER BY id").all() as { json: string }[])
      .map((r) => JSON.parse(r.json) as IndexedNode)
      .filter((n): n is IndexedNode & { type: "turn" } => n.type === "turn" && n.session === s.id)
      .sort((a, b) => a.index - b.index);
    out.push({
      session: s.id,
      harness: s.harness,
      started: s.started,
      turns: turns.map((t) => ({
        turn: t.id,
        index: t.index,
        timestamp: t.timestamp,
        prompt: t.prompt_excerpt,
        caused: db.prepare("SELECT id, type, title, status FROM nodes WHERE caused_by = ? ORDER BY type, id").all(t.id) as unknown as TimelineTurn["caused"],
      })),
    });
  }
  return out;
}

export function renderTimeline(sessions: TimelineSession[]): string {
  const lines: string[] = [];
  for (const s of sessions) {
    lines.push(`${s.session} (${s.harness}) started ${s.started}`);
    for (const t of s.turns) {
      lines.push(`  #${t.index} ${t.timestamp}  ${truncate(t.prompt, 100)}`);
      for (const c of t.caused) lines.push(`      -> ${c.id} (${c.type}${c.status ? `, ${c.status}` : ""}) ${c.title}`);
    }
  }
  return lines.join("\n") || "no sessions ingested";
}

export const KNOWN_RELS = new Set(Object.values(EDGE_SPECS).flat().map((s) => s.rel));
