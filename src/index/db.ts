import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { edgeSpec, extractEdges } from "../schema/edges.js";
import { kindOf, statusOf, type Node } from "../schema/nodes.js";
import { CONFIG_FILE } from "../store/config.js";
import { knowledgeDir, loadStore, type LoadedStore } from "../store/files.js";
import { ensureDir, fileMtimeMs, walkFiles } from "../util.js";

export const INDEX_REL = ".whitesnake/index.sqlite";

export function indexPath(root: string): string {
  return join(root, INDEX_REL);
}

const SCHEMA_SQL = `
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created TEXT NOT NULL,
  caused_by TEXT,
  json TEXT NOT NULL
);
CREATE TABLE edges (
  src TEXT NOT NULL,
  rel TEXT NOT NULL,
  dst TEXT NOT NULL,
  relies INTEGER NOT NULL,
  PRIMARY KEY (src, rel, dst)
);
CREATE INDEX edges_dst ON edges (dst, rel);
CREATE TABLE tokens (
  term TEXT NOT NULL,
  node_id TEXT NOT NULL,
  weight INTEGER NOT NULL,
  PRIMARY KEY (term, node_id)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Word tokens plus trigrams (prefixed with #) for words of four or more characters. */
export function tokenize(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const normalized = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  for (const word of normalized.split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length < 2) continue;
    out.set(word, 2);
    if (word.length >= 4) {
      for (let i = 0; i + 3 <= word.length; i++) {
        const tri = `#${word.slice(i, i + 3)}`;
        if (!out.has(tri)) out.set(tri, 1);
      }
    }
  }
  return out;
}

function indexedText(node: Node, body: string): string {
  const parts: string[] = [node.title, node.type];
  switch (node.type) {
    case "decision":
      parts.push(node.kind, node.claim, node.qualifier.scope, node.rebuttal.text, node.fragility);
      if (node.target) parts.push(node.target.unit, node.target.field, String(node.target.value));
      break;
    case "procedure":
      parts.push(node.entrypoint, node.resolution, ...node.applicability, ...node.abstain_when);
      break;
    case "question":
      parts.push(node.why);
      break;
    case "turn":
      parts.push(node.prompt_excerpt);
      break;
    case "evidence":
      if (node.execution) parts.push(node.execution.command);
      break;
    case "template":
      parts.push(node.summary, ...node.negative_examples);
      break;
    default:
      break;
  }
  parts.push(body);
  return parts.join("\n");
}

export function sourceMtime(root: string): number {
  let max = fileMtimeMs(join(root, CONFIG_FILE));
  for (const f of walkFiles(knowledgeDir(root))) max = Math.max(max, fileMtimeMs(f));
  return max;
}

export interface BuildStats {
  path: string;
  nodes: number;
  edges: number;
  tokens: number;
}

/** Full, deterministic rebuild: rows are inserted in sorted order so two builds of the same store are identical. */
export function buildIndex(root: string, loaded?: LoadedStore): BuildStats {
  const store = loaded ?? loadStore(root);
  const path = indexPath(root);
  ensureDir(join(root, ".whitesnake"));
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  const insNode = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insEdge = db.prepare("INSERT OR IGNORE INTO edges VALUES (?, ?, ?, ?)");
  const insTok = db.prepare("INSERT INTO tokens VALUES (?, ?, ?)");
  const insMeta = db.prepare("INSERT INTO meta VALUES (?, ?)");
  const ids = [...store.nodes.keys()].sort();
  let edges = 0;
  let tokens = 0;
  db.exec("BEGIN");
  for (const id of ids) {
    const node = store.nodes.get(id)!;
    const body = store.bodies.get(id) ?? "";
    const causedBy = "caused_by" in node ? (node.caused_by as string | null) : null;
    insNode.run(id, node.type, statusOf(node), kindOf(node), node.title, node.created, causedBy, JSON.stringify({ ...node, body }));
    const edgeList = extractEdges(node).sort((a, b) => a.rel.localeCompare(b.rel) || a.dst.localeCompare(b.dst));
    for (const e of edgeList) {
      insEdge.run(id, e.rel, e.dst, edgeSpec(node.type, e.rel)?.relies ? 1 : 0);
      edges++;
    }
    const toks = [...tokenize(indexedText(node, body)).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [term, weight] of toks) {
      insTok.run(term, id, weight);
      tokens++;
    }
  }
  insMeta.run("store_id", store.config.id);
  insMeta.run("node_count", String(ids.length));
  insMeta.run("source_mtime", String(sourceMtime(root)));
  db.exec("COMMIT");
  db.close();
  return { path, nodes: ids.length, edges, tokens };
}

export function openIndex(root: string): DatabaseSync {
  const path = indexPath(root);
  if (!existsSync(path)) buildIndex(root);
  return new DatabaseSync(path, { readOnly: true });
}

/** Open the index, rebuilding it first when any knowledge file is newer than the last build. */
export function ensureIndex(root: string): DatabaseSync {
  const path = indexPath(root);
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'source_mtime'").get() as { value: string } | undefined;
    db.close();
    if (row && Number(row.value) >= sourceMtime(root)) return new DatabaseSync(path, { readOnly: true });
  }
  buildIndex(root);
  return new DatabaseSync(path, { readOnly: true });
}

/** Canonical text dump of every table in primary-key order; identical stores give identical dumps. */
export function dumpIndex(root: string): string {
  const db = ensureIndex(root);
  const lines: string[] = [];
  for (const row of db.prepare("SELECT id, type, status, kind, title, created, caused_by, json FROM nodes ORDER BY id").all()) {
    lines.push(`N ${JSON.stringify(row)}`);
  }
  for (const row of db.prepare("SELECT src, rel, dst, relies FROM edges ORDER BY src, rel, dst").all()) {
    lines.push(`E ${JSON.stringify(row)}`);
  }
  for (const row of db.prepare("SELECT term, node_id, weight FROM tokens ORDER BY term, node_id").all()) {
    lines.push(`T ${JSON.stringify(row)}`);
  }
  for (const row of db.prepare("SELECT key, value FROM meta WHERE key <> 'source_mtime' ORDER BY key").all()) {
    lines.push(`M ${JSON.stringify(row)}`);
  }
  db.close();
  return `${lines.join("\n")}\n`;
}
