import { existsSync } from "node:fs";
import { join } from "node:path";
import { edgeSpec } from "../schema/edges.js";
import { isAuthoredType, newId, type NodeType } from "../schema/ids.js";
import { parseNode, type Node } from "../schema/nodes.js";
import { CliError, canonicalBody, isRecord, nowIso, readText, sha256 } from "../util.js";
import { loadStore, nodePath, readNodeFile, writeNodeFile, type LoadedStore } from "./files.js";
import { errorsOf, validateStore, warningsOf } from "./validate.js";
import type { ValidationIssue } from "./files.js";

/** Warnings produced by the last createNode/updateNode call, for the CLI to print. */
export let lastWarnings: ValidationIssue[] = [];

export const CURRENT_TURN_FILE = ".whitesnake/current-turn";

export function currentTurn(root: string): string | null {
  const p = join(root, CURRENT_TURN_FILE);
  if (!existsSync(p)) return null;
  const v = readText(p).trim();
  return v || null;
}

const HAS_CAUSED_BY: readonly NodeType[] = ["question", "decision", "evidence", "artifact", "procedure", "episode", "template"];

export interface WriteOptions {
  actor?: string;
  causedBy?: string | null;
  store?: LoadedStore;
}

/** Validate a candidate node against the whole store: schema already applied, now graph checks restricted to this node. */
function checkAgainstStore(root: string, node: Node, body: string, loaded?: LoadedStore): void {
  const store = loaded ?? loadStore(root);
  store.nodes.set(node.id, node);
  store.bodies.set(node.id, body);
  store.paths.set(node.id, nodePath(root, node.type, node.id));
  const mine = validateStore(store).filter((i) => i.id === node.id && i.code !== "E_ARTIFACT_MISSING");
  const errors = errorsOf(mine);
  lastWarnings = warningsOf(mine);
  if (errors.length) {
    throw new CliError(`${node.id} rejected: ${errors.map((i) => `${i.code} ${i.message}`).join("; ")}`, 2, errors);
  }
}

export function createNode(root: string, type: NodeType, input: Record<string, unknown>, body: string, opts: WriteOptions = {}): Node {
  const raw: Record<string, unknown> = { ...input, type };
  if (raw["id"] === undefined) {
    if (!isAuthoredType(type)) throw new CliError(`${type} nodes need an explicit derived id`, 1);
    raw["id"] = newId(type);
  }
  if (raw["created"] === undefined) raw["created"] = nowIso();
  if (raw["created_by"] === undefined) raw["created_by"] = opts.actor ?? process.env["WHITESNAKE_ACTOR"] ?? "agent";
  if (HAS_CAUSED_BY.includes(type) && raw["caused_by"] === undefined) {
    raw["caused_by"] = opts.causedBy === undefined ? currentTurn(root) : opts.causedBy;
  }
  if (type === "evidence" && raw["hash"] === undefined) raw["hash"] = sha256(canonicalBody(body));
  if (type === "episode" && raw["started"] === undefined) raw["started"] = raw["created"];
  if (type === "turn" && raw["prompt_hash"] === undefined && typeof raw["prompt_excerpt"] === "string") {
    raw["prompt_hash"] = sha256(raw["prompt_excerpt"]);
  }
  const parsed = parseNode(raw);
  if (!parsed.ok) {
    throw new CliError(`invalid ${type}: ${parsed.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`, 2, parsed.issues);
  }
  const path = nodePath(root, type, parsed.node.id);
  if (existsSync(path)) throw new CliError(`${parsed.node.id} already exists`, 1);
  checkAgainstStore(root, parsed.node, body, opts.store);
  writeNodeFile(root, parsed.node, body);
  return parsed.node;
}

const SHALLOW_MERGE_KEYS = new Set(["qualifier", "locator", "rebuttal", "counters", "target", "qualified_on", "compacted_from"]);

export function updateNode(root: string, id: string, patch: Record<string, unknown>, body?: string, opts: WriteOptions = {}): Node {
  const store = opts.store ?? loadStore(root);
  const existing = store.nodes.get(id);
  if (!existing) throw new CliError(`unknown node ${id}`, 1);
  if ("id" in patch && patch["id"] !== id) throw new CliError("the id of a node cannot change", 1);
  if ("type" in patch && patch["type"] !== existing.type) throw new CliError("the type of a node cannot change", 1);
  const raw: Record<string, unknown> = { ...(existing as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (SHALLOW_MERGE_KEYS.has(k) && isRecord(v) && isRecord(raw[k])) raw[k] = { ...(raw[k] as Record<string, unknown>), ...v };
    else raw[k] = v;
  }
  const newBody = body ?? store.bodies.get(id) ?? "";
  if (existing.type === "evidence" && body !== undefined && patch["hash"] === undefined) raw["hash"] = sha256(canonicalBody(newBody));
  const parsed = parseNode(raw);
  if (!parsed.ok) {
    throw new CliError(`invalid patch for ${id}: ${parsed.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`, 2, parsed.issues);
  }
  checkAgainstStore(root, parsed.node, newBody, store);
  writeNodeFile(root, parsed.node, newBody);
  return parsed.node;
}

export function linkNodes(root: string, src: string, rel: string, dsts: string[], opts: WriteOptions = {}): Node {
  const store = opts.store ?? loadStore(root);
  const node = store.nodes.get(src);
  if (!node) throw new CliError(`unknown node ${src}`, 1);
  const spec = edgeSpec(node.type, rel);
  if (!spec) throw new CliError(`${node.type} nodes have no edge field "${rel}"`, 1);
  const raw = node as unknown as Record<string, unknown>;
  let container: Record<string, unknown> = raw;
  for (const key of spec.path.slice(0, -1)) container = container[key] as Record<string, unknown>;
  const leaf = spec.path[spec.path.length - 1]!;
  const current = container[leaf];
  const patchValue = Array.isArray(current) ? [...new Set([...(current as string[]), ...dsts])] : dsts.length === 1 ? dsts[0] : undefined;
  if (patchValue === undefined) throw new CliError(`${rel} holds a single reference; pass exactly one id`, 1);
  const patch: Record<string, unknown> =
    spec.path.length === 1 ? { [leaf]: patchValue } : { [spec.path[0]!]: { ...(raw[spec.path[0]!] as Record<string, unknown>), [leaf]: patchValue } };
  return updateNode(root, src, patch, undefined, { ...opts, store });
}

export function readNode(root: string, id: string): { node: Node; body: string } | null {
  const store = loadStore(root);
  const node = store.nodes.get(id);
  if (!node) return null;
  const file = readNodeFile(join(root, store.paths.get(id)!));
  return { node, body: file.body };
}
