import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CliError, readText, writeText } from "../util.js";

export const CONFIG_FILE = "autosoft.yaml";

export const FieldSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "field names are snake_case"),
  type: z.enum(["integer", "number", "string", "boolean"]),
  description: z.string().default(""),
});

export const ConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "store id: lowercase letters, digits, dashes"),
  name: z.string().min(1),
  schema_version: z.literal(1),
  mandate: z.string().default(""),
  harness: z.enum(["claude", "codex"]).default("claude"),
  model: z.string().nullable().default(null),
  corpus: z.array(z.string()).default(["corpus"]),
  output: z
    .strictObject({
      unit: z.string().default("unit"),
      fields: z.array(FieldSchema).default([]),
    })
    .default({ unit: "unit", fields: [] }),
  promotion: z
    .strictObject({
      /** Shown uses without a correction after which a provisional procedure becomes trusted. */
      shown_uses_to_trust: z.number().int().min(1).default(3),
    })
    .default({ shown_uses_to_trust: 3 }),
});
export type StoreConfig = z.infer<typeof ConfigSchema>;

/** Walk up from `start` until a directory containing autosoft.yaml is found. */
export function findStoreRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireStoreRoot(start: string): string {
  const root = findStoreRoot(start);
  if (!root) throw new CliError(`No ${CONFIG_FILE} found from ${start} upwards. Run \`autosoft init <dir>\` first.`, 1);
  return root;
}

export function loadConfig(root: string): StoreConfig {
  const path = join(root, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = YAML.parse(readText(path));
  } catch (e) {
    throw new CliError(`Cannot parse ${path}: ${(e as Error).message}`, 2);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new CliError(`Invalid ${path}: ${msg}`, 2);
  }
  return parsed.data;
}

export function writeConfig(root: string, cfg: StoreConfig): void {
  writeText(join(root, CONFIG_FILE), YAML.stringify(cfg, { lineWidth: 0 }));
}
