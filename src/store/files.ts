import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import YAML from "yaml";
import { DIR_TYPE, TYPE_DIR, isValidId, type NodeType } from "../schema/ids.js";
import { parseNode, type Node } from "../schema/nodes.js";
import { CliError, canonicalBody, listFiles, readText, writeText } from "../util.js";
import { loadConfig, type StoreConfig } from "./config.js";
import { recordWrite } from "./journal.js";

export interface ValidationIssue {
  code: string;
  message: string;
  /** Errors make the store invalid (exit 2); warnings flag recording habits that blunt `affected`. */
  severity?: "error" | "warning";
  id?: string;
  file?: string;
  path?: string;
}

export interface RawNodeFile {
  path: string;
  frontmatter: unknown;
  body: string;
}

export function knowledgeDir(root: string): string {
  return join(root, "knowledge");
}

export function nodePath(root: string, type: NodeType, id: string): string {
  return join(knowledgeDir(root), TYPE_DIR[type], `${id}.md`);
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const m = FM_RE.exec(text);
  if (!m) return null;
  return { frontmatter: m[1] ?? "", body: (m[2] ?? "").replace(/^\r?\n/, "") };
}

export function readNodeFile(path: string): RawNodeFile {
  const text = readText(path);
  const split = splitFrontmatter(text);
  if (!split) throw new CliError(`${path}: missing YAML frontmatter delimited by ---`, 2);
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(split.frontmatter);
  } catch (e) {
    throw new CliError(`${path}: invalid YAML frontmatter: ${(e as Error).message}`, 2);
  }
  return { path, frontmatter, body: canonicalBody(split.body) };
}

/** Deterministic serialization: schema key order, no line folding, single trailing newline. */
export function serializeNode(node: Node, body: string): string {
  const fm = YAML.stringify(node, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });
  const trimmed = canonicalBody(body);
  return `---\n${fm}---\n${trimmed ? `\n${trimmed}\n` : ""}`;
}

export function writeNodeFile(root: string, node: Node, body: string): string {
  const path = nodePath(root, node.type, node.id);
  const text = serializeNode(node, body);
  writeText(path, text);
  recordWrite(root, path, text);
  return path;
}

export interface LoadedStore {
  root: string;
  config: StoreConfig;
  nodes: Map<string, Node>;
  bodies: Map<string, string>;
  paths: Map<string, string>;
  issues: ValidationIssue[];
}

/** Load every node file, parsing schemas and collecting file-level issues. Graph checks live in validate.ts. */
export function loadStore(root: string): LoadedStore {
  const config = loadConfig(root);
  const store: LoadedStore = { root, config, nodes: new Map(), bodies: new Map(), paths: new Map(), issues: [] };
  const kdir = knowledgeDir(root);
  if (!existsSync(kdir)) return store;

  for (const entry of readdirSync(kdir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dirType = DIR_TYPE[entry.name];
    const dirPath = join(kdir, entry.name);
    if (!dirType) {
      for (const f of listFiles(dirPath, ".md")) {
        store.issues.push({ code: "E_UNKNOWN_TYPE", file: relative(root, f), message: `unknown node directory knowledge/${entry.name}` });
      }
      continue;
    }
    for (const file of listFiles(dirPath, ".md")) {
      const rel = relative(root, file);
      let raw: RawNodeFile;
      try {
        raw = readNodeFile(file);
      } catch (e) {
        store.issues.push({ code: "E_PARSE", file: rel, message: (e as Error).message });
        continue;
      }
      const parsed = parseNode(raw.frontmatter);
      if (!parsed.ok) {
        const fmType = parsed.type;
        if (fmType === null) {
          store.issues.push({ code: "E_UNKNOWN_TYPE", file: rel, message: "frontmatter type is missing or unknown" });
          continue;
        }
        for (const issue of parsed.issues) {
          store.issues.push({ code: "E_SCHEMA", file: rel, path: issue.path, message: issue.message });
        }
        continue;
      }
      const node = parsed.node;
      if (node.type !== dirType) {
        store.issues.push({ code: "E_WRONG_DIR", file: rel, id: node.id, message: `node of type ${node.type} stored under knowledge/${entry.name}` });
      }
      if (!isValidId(node.id, node.type)) {
        store.issues.push({ code: "E_ID_FORMAT", file: rel, id: node.id, message: `id ${node.id} does not match the ${node.type} id format` });
      }
      if (basename(file, ".md") !== node.id) {
        store.issues.push({ code: "E_FILENAME", file: rel, id: node.id, message: `file name must equal the node id (${node.id})` });
      }
      if (store.nodes.has(node.id)) {
        store.issues.push({ code: "E_DUPLICATE_ID", file: rel, id: node.id, message: `duplicate id ${node.id} (also in ${store.paths.get(node.id)})` });
        continue;
      }
      store.nodes.set(node.id, node);
      store.bodies.set(node.id, raw.body);
      store.paths.set(node.id, rel);
    }
  }
  return store;
}
