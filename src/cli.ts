#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import YAML from "yaml";
import { runHook, type HookInput } from "./hooks/run.js";
import { buildIndex, dumpIndex, ensureIndex } from "./index/db.js";
import { affected, frontier, getNode, listNodes, precedent, renderFrontier, renderTimeline, renderWhy, resolveRef, timeline, why } from "./index/queries.js";
import { claudeLogPath, ingestClaudeLogFile } from "./ingest/claude.js";
import { NODE_TYPES, TYPE_DIR, type NodeType } from "./schema/ids.js";
import { CONFIG_FILE, ConfigSchema, findStoreRoot, requireStoreRoot, writeConfig } from "./store/config.js";
import { loadStore, serializeNode } from "./store/files.js";
import { createNode, currentTurn, linkNodes, readNode, updateNode } from "./store/ops.js";
import { validateStore } from "./store/validate.js";
import { CliError, ensureDir, readText, writeText } from "./util.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(here, "..", "..");
const SKILL_DIR = join(TOOL_ROOT, "skill", "autosoft");
const CLI_PATH = fileURLToPath(import.meta.url);
/** Command used by hooks: absolute, so it works without PATH configuration. */
const AUTOSOFT_CMD = `${JSON.stringify(process.execPath)} --disable-warning=ExperimentalWarning ${JSON.stringify(CLI_PATH)}`;

const program = new Command();
program
  .name("autosoft")
  .description("Knowledge store with provenance for agentic research processes")
  .version(JSON.parse(readFileSync(join(TOOL_ROOT, "package.json"), "utf8")).version as string)
  .option("--store <dir>", "store directory (default: nearest autosoft.yaml upwards from cwd)")
  .option("--json", "machine-readable output");

type GlobalOpts = { store?: string; json?: boolean };
const globals = (): GlobalOpts => program.opts<GlobalOpts>();
const root = (): string => requireStoreRoot(resolve(globals().store ?? process.cwd()));
const print = (human: string, data: unknown): void => {
  console.log(globals().json ? JSON.stringify(data, null, 2) : human);
};
const parseJsonArg = (s: string | undefined): Record<string, unknown> => {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    throw new CliError(`--json argument is not a JSON object: ${(e as Error).message}`, 1);
  }
};
const bodyFrom = (opts: { body?: string; bodyFile?: string }): string => {
  if (opts.bodyFile) return readText(opts.bodyFile);
  return opts.body ?? "";
};

program
  .command("init <dir>")
  .description("create a new store: autosoft.yaml, knowledge/, skill link, hooks, git repository")
  .requiredOption("--id <id>", "store id (lowercase, digits, dashes)")
  .option("--name <name>", "human name")
  .option("--mandate <text>", "what this store is for", "")
  .option("--harness <h>", "claude or codex", "claude")
  .option("--unit <name>", "name of the annotated unit (e.g. paper)", "unit")
  .option("--field <spec...>", "output fields as name:type[:description]")
  .option("--no-git", "do not initialise a git repository")
  .option("--no-hooks", "do not install hook settings")
  .action((dir: string, opts: { id: string; name?: string; mandate: string; harness: string; unit: string; field?: string[]; git: boolean; hooks: boolean }) => {
    const target = resolve(dir);
    if (existsSync(join(target, CONFIG_FILE))) throw new CliError(`${target} already contains ${CONFIG_FILE}`, 1);
    const fields = (opts.field ?? []).map((spec) => {
      const [name, type, ...rest] = spec.split(":");
      return { name: name ?? "", type: (type ?? "string") as "string", description: rest.join(":") };
    });
    const cfg = ConfigSchema.parse({ id: opts.id, name: opts.name ?? opts.id, schema_version: 1, mandate: opts.mandate, harness: opts.harness, output: { unit: opts.unit, fields } });
    ensureDir(target);
    writeConfig(target, cfg);
    for (const d of Object.values(TYPE_DIR)) {
      ensureDir(join(target, "knowledge", d));
      writeText(join(target, "knowledge", d, ".gitkeep"), "");
    }
    for (const d of ["corpus", "procedures", "artifacts", "output", ".autosoft"]) ensureDir(join(target, d));
    writeText(join(target, ".gitignore"), ".autosoft/\noutput/*.sqlite\n.DS_Store\n");
    installSkillAndHooks(target, opts.hooks);
    if (opts.git && !existsSync(join(target, ".git"))) {
      execFileSync("git", ["-C", target, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", target, "add", "-A"]);
      execFileSync("git", ["-C", target, "commit", "-q", "-m", "store: initialise AutoSoft store"]);
    }
    print(`Initialised store ${cfg.id} at ${target}`, { root: target, config: cfg });
  });

function installSkillAndHooks(target: string, hooks: boolean): void {
  for (const skillsDir of [join(target, ".claude", "skills"), join(target, ".agents", "skills")]) {
    ensureDir(skillsDir);
    const link = join(skillsDir, "autosoft");
    if (!existsSync(link)) symlinkSync(SKILL_DIR, link, "dir");
  }
  const pointer = [
    "# AutoSoft store",
    "",
    "This directory is an AutoSoft knowledge store. Follow the `autosoft` skill (`.claude/skills/autosoft/SKILL.md`):",
    "consult `autosoft precedent` and `autosoft frontier` before deciding, record decisions and evidence through the CLI,",
    "and never edit files under `knowledge/` by hand.",
    "",
  ].join("\n");
  writeText(join(target, "CLAUDE.md"), pointer);
  writeText(join(target, "AGENTS.md"), pointer);
  if (hooks) {
    const template = readText(join(TOOL_ROOT, "hooks", "templates", "claude-settings.json"));
    const settingsPath = join(target, ".claude", "settings.json");
    const existing = existsSync(settingsPath) ? (JSON.parse(readText(settingsPath)) as Record<string, unknown>) : {};
    const hookCfg = JSON.parse(template.replaceAll("{{AUTOSOFT}}", AUTOSOFT_CMD.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))) as Record<string, unknown>;
    writeText(settingsPath, `${JSON.stringify({ ...existing, ...hookCfg }, null, 2)}\n`);
  }
}

program
  .command("hooks")
  .description("hook runner and installer")
  .addCommand(
    new Command("run")
      .argument("<event>", "SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop | PreCompact | SessionEnd")
      .option("--harness <h>", "claude or codex", "claude")
      .description("run a hook: reads the harness payload from stdin")
      .action((event: string, opts: { harness: "claude" | "codex" }) => {
        let input: HookInput = {};
        try {
          const raw = readFileSync(0, "utf8");
          if (raw.trim()) input = JSON.parse(raw) as HookInput;
        } catch {
          input = {};
        }
        input.harness = opts.harness;
        const out = runHook(event, input);
        if (out.stdout) process.stdout.write(out.stdout.endsWith("\n") ? out.stdout : `${out.stdout}\n`);
        if (out.stderr) process.stderr.write(`${out.stderr}\n`);
        process.exitCode = out.exitCode;
      }),
  )
  .addCommand(
    new Command("install").description("(re)install skill links, CLAUDE.md/AGENTS.md pointers and hook settings into the store").action(() => {
      installSkillAndHooks(root(), true);
      print("Skill and hooks installed", { root: root() });
    }),
  );

program
  .command("add <type>")
  .description("create a node; prints its id")
  .option("--json-in <json>", "frontmatter fields as a JSON object")
  .option("--body <text>", "markdown body (evidence excerpt, rationale, prompt)")
  .option("--body-file <path>", "read the body from a file")
  .option("--caused-by <turn>", "override the current turn")
  .option("--actor <name>", "created_by value (default: AUTOSOFT_ACTOR or agent)")
  .action((type: string, opts: { jsonIn?: string; body?: string; bodyFile?: string; causedBy?: string; actor?: string }) => {
    if (!(NODE_TYPES as readonly string[]).includes(type)) throw new CliError(`unknown type ${type}; one of ${NODE_TYPES.join(", ")}`, 1);
    const r = root();
    const node = createNode(r, type as NodeType, parseJsonArg(opts.jsonIn), bodyFrom(opts), { causedBy: opts.causedBy, actor: opts.actor });
    print(node.id, node);
  });

program
  .command("set <id>")
  .description("patch a node's frontmatter and/or body (shallow merge for nested objects, arrays replaced)")
  .option("--json-in <json>", "patch as a JSON object")
  .option("--body <text>", "replace the body")
  .option("--body-file <path>", "replace the body from a file")
  .action((id: string, opts: { jsonIn?: string; body?: string; bodyFile?: string }) => {
    const body = opts.body !== undefined || opts.bodyFile !== undefined ? bodyFrom(opts) : undefined;
    const node = updateNode(root(), id, parseJsonArg(opts.jsonIn), body);
    print(`${node.id} updated`, node);
  });

program
  .command("link <src> <rel> <dst...>")
  .description("append references to an edge field (e.g. link dec_x data ev_y ev_z)")
  .action((src: string, rel: string, dst: string[]) => {
    const node = linkNodes(root(), src, rel, dst);
    print(`${node.id}.${rel} now ${JSON.stringify((node as unknown as Record<string, unknown>)[rel] ?? "(nested)")}`, node);
  });

program
  .command("get <ref>")
  .description("show a node (id or unit/field for the current annotation of a cell)")
  .action((ref: string) => {
    const r = root();
    const db = ensureIndex(r);
    const id = resolveRef(db, ref);
    db.close();
    if (!id) throw new CliError(`no node matches ${ref}`, 1);
    const found = readNode(r, id);
    if (!found) throw new CliError(`no node ${id}`, 1);
    print(serializeNode(found.node, found.body), { ...found.node, body: found.body });
  });

program
  .command("ls [type]")
  .description("list nodes")
  .option("--status <s>")
  .option("--kind <k>")
  .action((type: string | undefined, opts: { status?: string; kind?: string }) => {
    const db = ensureIndex(root());
    const rows = listNodes(db, { type, status: opts.status, kind: opts.kind });
    db.close();
    print(rows.map((r) => `${r.id}\t${r.type}${r.kind ? `/${r.kind}` : ""}\t${r.status}\t${r.title}`).join("\n") || "(none)", rows);
  });

program
  .command("validate")
  .description("check every record: schema, ids, edges, hashes, states. Exit 2 on errors")
  .action(() => {
    const issues = validateStore(loadStore(root()));
    if (issues.length) {
      print(issues.map((i) => `${i.code}\t${i.file ?? i.id ?? ""}\t${i.path ?? ""}\t${i.message}`).join("\n"), { ok: false, issues });
      process.exitCode = 2;
    } else {
      print("ok: store is valid", { ok: true, issues: [] });
    }
  });

program
  .command("index")
  .description("rebuild the SQLite index from the records")
  .option("--dump", "print the canonical dump instead of statistics")
  .action((opts: { dump?: boolean }) => {
    const r = root();
    const stats = buildIndex(r);
    if (opts.dump) {
      process.stdout.write(dumpIndex(r));
      return;
    }
    print(`indexed ${stats.nodes} nodes, ${stats.edges} edges, ${stats.tokens} tokens -> ${stats.path}`, stats);
  });

program
  .command("why <ref>")
  .description("provenance chain of a node or of a cell given as unit/field")
  .action((ref: string) => {
    const db = ensureIndex(root());
    const id = resolveRef(db, ref);
    const tree = id ? why(db, id) : null;
    db.close();
    if (!tree) throw new CliError(`no node matches ${ref}`, 1);
    print(renderWhy(tree), tree);
  });

program
  .command("affected <id>")
  .description("everything that transitively relies on a node (what to re-examine if it changes)")
  .action((id: string) => {
    const db = ensureIndex(root());
    if (!getNode(db, id)) {
      db.close();
      throw new CliError(`no node ${id}`, 1);
    }
    const rows = affected(db, id);
    db.close();
    print(rows.map((r) => `${r.depth}\t${r.id}\t${r.type}\t${r.status}\t${r.title}`).join("\n") || "(nothing depends on it)", rows);
  });

program
  .command("precedent <text...>")
  .description("search prior decisions, procedures, questions and episodes by text")
  .option("--type <t...>", "restrict to node types")
  .option("--limit <n>", "max results", "10")
  .action((text: string[], opts: { type?: string[]; limit: string }) => {
    const db = ensureIndex(root());
    const rows = precedent(db, text.join(" "), { types: opts.type, limit: Number(opts.limit) });
    db.close();
    print(rows.map((r) => `${r.score}\t${r.id}\t${r.type}${r.kind ? `/${r.kind}` : ""}\t${r.status}\t${r.title}`).join("\n") || "(no precedent found)", rows);
  });

program
  .command("frontier")
  .description("open questions, proposed decisions, provisional procedures, open episodes")
  .action(() => {
    const db = ensureIndex(root());
    const f = frontier(db);
    db.close();
    print(renderFrontier(f), f);
  });

program
  .command("timeline")
  .description("sessions and turns with the records each prompt caused")
  .option("--session <id>")
  .action((opts: { session?: string }) => {
    const db = ensureIndex(root());
    const t = timeline(db, opts.session);
    db.close();
    print(renderTimeline(t), t);
  });

program
  .command("turn")
  .description("show the current turn id written by the UserPromptSubmit hook")
  .action(() => {
    const t = currentTurn(root());
    print(t ?? "(no current turn)", { turn: t });
  });

program
  .command("ingest [log]")
  .description("import a native session log (Claude Code JSONL) as session and turn nodes")
  .option("--session <id>", "Claude Code session id; the log path is derived from the store cwd")
  .action((log: string | undefined, opts: { session?: string }) => {
    const r = root();
    const path = log ?? (opts.session ? claudeLogPath(opts.session, r) : undefined);
    if (!path) throw new CliError("pass a log file or --session <id>", 1);
    const result = ingestClaudeLogFile(r, path);
    if (!result) throw new CliError(`no parsable session in ${path}`, 1);
    print(`ingested ${result.session}: ${result.turns} turns, ${result.written} files written${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`, result);
  });

program
  .command("export-output")
  .description("rebuild output/annotations.csv from the active annotation decisions")
  .action(() => {
    const r = root();
    const store = loadStore(r);
    const fields = store.config.output.fields.map((f) => f.name);
    const rows = new Map<string, Record<string, unknown>>();
    const decisions = [...store.nodes.values()].filter((n) => n.type === "decision" && n.kind === "annotation" && n.target && (n.status === "active" || n.status === "proposed" || n.status === "needs_review")).sort((a, b) => a.created.localeCompare(b.created));
    for (const d of decisions) {
      if (d.type !== "decision" || !d.target) continue;
      const row = rows.get(d.target.unit) ?? { [store.config.output.unit]: d.target.unit };
      row[d.target.field] = d.target.value;
      row[`${d.target.field}__decision`] = d.id;
      row[`${d.target.field}__status`] = d.status;
      rows.set(d.target.unit, row);
    }
    const header = [store.config.output.unit, ...fields.flatMap((f) => [f, `${f}__decision`, `${f}__status`])];
    const csv = [header.join(","), ...[...rows.keys()].sort().map((u) => header.map((h) => csvCell(rows.get(u)![h])).join(","))].join("\n");
    writeText(join(r, "output", "annotations.csv"), `${csv}\n`);
    print(`wrote ${rows.size} rows to output/annotations.csv`, { rows: [...rows.values()] });
  });

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

program
  .command("doctor")
  .description("check runtime, SQLite features, harness CLIs and the store")
  .action(() => {
    const checks: Record<string, unknown> = {};
    const [major, minor] = process.versions.node.split(".").map(Number);
    checks["node"] = { version: process.versions.node, ok: (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13) };
    try {
      const db = new DatabaseSync(":memory:");
      const r = db.prepare("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<5) SELECT sum(n) s FROM c").get() as { s: number };
      db.close();
      checks["sqlite_recursive_cte"] = { ok: r.s === 15 };
    } catch (e) {
      checks["sqlite_recursive_cte"] = { ok: false, error: (e as Error).message };
    }
    for (const bin of ["claude", "codex", "git"]) {
      const w = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
      checks[bin] = { ok: w.status === 0, path: w.stdout.trim() || null };
    }
    const r = findStoreRoot(resolve(globals().store ?? process.cwd()));
    checks["store"] = r ? { ok: true, root: r, validation_errors: validateStore(loadStore(r)).length } : { ok: false, note: "no autosoft.yaml found" };
    checks["skill"] = { ok: existsSync(join(SKILL_DIR, "SKILL.md")), path: SKILL_DIR };
    const allOk = Object.values(checks).every((c) => (c as { ok: boolean }).ok);
    print(Object.entries(checks).map(([k, v]) => `${(v as { ok: boolean }).ok ? "ok  " : "FAIL"} ${k} ${JSON.stringify(v)}`).join("\n"), { ok: allOk, checks });
    if (!allOk) process.exitCode = 1;
  });

program
  .command("config")
  .description("print the store configuration")
  .action(() => {
    const store = loadStore(root());
    print(YAML.stringify(store.config), store.config);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      if (globals().json) console.log(JSON.stringify({ ok: false, error: e.message, details: e.details ?? null }, null, 2));
      else console.error(`error: ${e.message}`);
      process.exitCode = e.exitCode;
      return;
    }
    throw e;
  }
}

await main();
