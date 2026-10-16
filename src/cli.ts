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
import { claudeLogPath } from "./ingest/claude.js";
import { ingestLogFile } from "./ingest/index.js";
import { NODE_TYPES, TYPE_DIR, type NodeType } from "./schema/ids.js";
import { CONFIG_FILE, ConfigSchema, findStoreRoot, requireStoreRoot, writeConfig } from "./store/config.js";
import { loadStore, serializeNode } from "./store/files.js";
import { createNode, currentTurn, lastWarnings, linkNodes, readNode, updateNode } from "./store/ops.js";
import { errorsOf, validateStore, warningsOf } from "./store/validate.js";
import { correctDecision } from "./lifecycle/correct.js";
import { kpi, renderKpi } from "./lifecycle/kpi.js";
import { reinstate, retire } from "./lifecycle/procedures.js";
import { resolve as resolveLadder } from "./lifecycle/resolve.js";
import { markShown } from "./lifecycle/shown.js";
import { renderReview } from "./render/html.js";
import { checkStore, exportStore } from "./handoff.js";
import { branchStatus, mergeParentBranch, openParentBranch } from "./branch.js";
import { askStore } from "./agent/ask.js";
import { childRootFor, delegateTask } from "./agent/delegate.js";
import type { RunnerHarness } from "./agent/runner.js";
import { applyGc, planGc } from "./gc/gc.js";
import { collapseEpisode } from "./gc/collapse.js";
import { recheckProcedure } from "./gc/recheck.js";
import { CliError, ensureDir, nowIso, readText, writeText } from "./util.js";

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
const printWarnings = (): void => {
  for (const w of lastWarnings) console.error(`note: ${w.code} ${w.message}`);
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
    writeText(join(target, ".gitignore"), ".autosoft/\noutput/*.sqlite\nreview.html\n.DS_Store\n");
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
    const escaped = AUTOSOFT_CMD.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    // Claude Code: hooks live inside .claude/settings.json, merged with whatever else is there.
    const claudeTemplate = readText(join(TOOL_ROOT, "hooks", "templates", "claude-settings.json"));
    const settingsPath = join(target, ".claude", "settings.json");
    const existing = existsSync(settingsPath) ? (JSON.parse(readText(settingsPath)) as Record<string, unknown>) : {};
    const hookCfg = JSON.parse(claudeTemplate.replaceAll("{{AUTOSOFT}}", escaped)) as Record<string, unknown>;
    writeText(settingsPath, `${JSON.stringify({ ...existing, ...hookCfg }, null, 2)}\n`);
    // Codex: a dedicated .codex/hooks.json with the same event/matcher/handler shape. Codex runs project hooks only once
    // the .codex layer is trusted (or with --dangerously-bypass-hook-trust in headless automation).
    const codexTemplate = readText(join(TOOL_ROOT, "hooks", "templates", "codex-hooks.json"));
    writeText(join(target, ".codex", "hooks.json"), codexTemplate.replaceAll("{{AUTOSOFT}}", escaped));
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
    printWarnings();
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
    printWarnings();
    print(`${node.id} updated`, node);
  });

program
  .command("link <src> <rel> <dst...>")
  .description("append references to an edge field (e.g. link dec_x data ev_y ev_z)")
  .action((src: string, rel: string, dst: string[]) => {
    const node = linkNodes(root(), src, rel, dst);
    printWarnings();
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
  .description("check every record: schema, ids, edges, hashes, states. Exit 2 on errors; warnings do not fail")
  .action(() => {
    const all = validateStore(loadStore(root()));
    const errors = errorsOf(all);
    const warnings = warningsOf(all);
    const line = (i: (typeof all)[number]) => `${i.code}\t${i.file ?? i.id ?? ""}\t${i.path ?? ""}\t${i.message}`;
    if (errors.length) {
      print([...errors.map(line), ...warnings.map(line)].join("\n"), { ok: false, issues: errors, warnings });
      process.exitCode = 2;
    } else {
      print([`ok: store is valid${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`, ...warnings.map(line)].join("\n"), { ok: true, issues: [], warnings });
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
  .description("import a native session log (Claude Code or Codex JSONL) as session and turn nodes")
  .option("--session <id>", "Claude Code session id; the log path is derived from the store cwd")
  .action((log: string | undefined, opts: { session?: string }) => {
    const r = root();
    const path = log ?? (opts.session ? claudeLogPath(opts.session, r) : undefined);
    if (!path) throw new CliError("pass a log file or --session <id>", 1);
    const result = ingestLogFile(r, path);
    if (!result) throw new CliError(`no parsable session in ${path}`, 1);
    print(`ingested ${result.session} (${result.format}): ${result.turns} turns, ${result.written} files written${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`, result);
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
  .command("episode")
  .description("open and close episodes (units of work)")
  .addCommand(
    new Command("open")
      .argument("<title>")
      .option("--parent <id>", "parent episode")
      .option("--resolution <r>", "cached | code | frozen_prompt | agent", "agent")
      .option("--question <id>", "question this episode addresses")
      .option("--uses <ids...>", "procedures and criteria this episode applies")
      .description("create an open episode; prints its id")
      .action((title: string, opts: { parent?: string; resolution: string; question?: string; uses?: string[] }) => {
        const node = createNode(root(), "episode", { title, parent: opts.parent ?? null, resolution: opts.resolution, question: opts.question ?? null, uses: opts.uses ?? [] }, "");
        printWarnings();
        print(node.id, node);
      }),
  )
  .addCommand(
    new Command("close")
      .argument("<id>")
      .option("--outcome <o>", "success | failure | abstained | corrected", "success")
      .option("--produces <ids...>", "records produced (merged)")
      .option("--uses <ids...>", "procedures and criteria applied (merged)")
      .option("--body <text>", "what was tried, including dead ends")
      .description("close an episode with its outcome")
      .action((id: string, opts: { outcome: string; produces?: string[]; uses?: string[]; body?: string }) => {
        const r = root();
        const existing = readNode(r, id);
        if (!existing || existing.node.type !== "episode") throw new CliError(`${id} is not an episode`, 1);
        const patch: Record<string, unknown> = { outcome: opts.outcome, ended: nowIso() };
        if (opts.produces) patch["produces"] = [...new Set([...existing.node.produces, ...opts.produces])];
        if (opts.uses) patch["uses"] = [...new Set([...existing.node.uses, ...opts.uses])];
        const node = updateNode(r, id, patch, opts.body);
        printWarnings();
        print(`${node.id} closed (${opts.outcome})`, node);
      }),
  );

program
  .command("shown <ids...>")
  .description("record that these decisions were presented to the researcher in the current turn")
  .option("--turn <id>", "override the current turn")
  .action((ids: string[], opts: { turn?: string }) => {
    const r = root();
    const result = markShown(loadStore(r), ids, opts.turn ?? currentTurn(r));
    print(
      [`shown: ${result.shown.join(", ") || "none"}`, result.already.length ? `already shown this turn: ${result.already.join(", ")}` : "", result.unknown.length ? `unknown: ${result.unknown.join(", ")}` : "", result.promoted.length ? `promoted to trusted: ${result.promoted.join(", ")}` : ""].filter(Boolean).join("\n"),
      result,
    );
  });

program
  .command("correct <id>")
  .description("the researcher says this decision is wrong: mark it, suspend the procedures behind it, flag dependents")
  .requiredOption("--reason <text>", "what the researcher said")
  .option("--value <json>", "the corrected value; creates a superseding decision")
  .option("--turn <id>", "override the current turn")
  .action((id: string, opts: { reason: string; value?: string; turn?: string }) => {
    const r = root();
    let value: unknown;
    if (opts.value !== undefined) {
      try {
        value = JSON.parse(opts.value);
      } catch {
        value = opts.value;
      }
    }
    const result = correctDecision(loadStore(r), id, opts.reason, opts.turn ?? currentTurn(r), { value });
    print(
      [`${id} ${result.replacement ? `superseded by ${result.replacement}` : "marked needs_review"}`, `needs_review: ${result.needs_review.join(", ") || "none"}`, `suspended procedures: ${result.suspended.join(", ") || "none"}`].join("\n"),
      result,
    );
  });

program
  .command("procedure")
  .description("manual procedure transitions")
  .addCommand(
    new Command("reinstate").argument("<id>").requiredOption("--reason <text>").description("suspended -> provisional after a fix").action((id: string, opts: { reason: string }) => {
      const r = root();
      const p = reinstate(loadStore(r), id, opts.reason, currentTurn(r));
      print(`${p.id} is now ${p.state}`, p);
    }),
  )
  .addCommand(
    new Command("retire").argument("<id>").requiredOption("--reason <text>").description("stop using a procedure; its outputs stand").action((id: string, opts: { reason: string }) => {
      const r = root();
      const p = retire(loadStore(r), id, opts.reason, currentTurn(r));
      print(`${p.id} is now ${p.state}`, p);
    }),
  )
  .addCommand(
    new Command("recheck")
      .argument("<id>")
      .option("--harness <h>", "claude | codex | stub", "claude")
      .option("--model <m>", "model to test without the procedure")
      .option("--retire", "retire the procedure when the model alone passes every regression case")
      .description("sublation check: can the model alone reproduce the regression cases?")
      .action((id: string, opts: { harness: string; model?: string; retire?: boolean }) => {
        const r = root();
        const result = recheckProcedure(loadStore(r), id, { harness: opts.harness as RunnerHarness, model: opts.model ?? null, retireOnPass: !!opts.retire });
        print([`${result.procedure}: ${result.cases.filter((c) => c.pass).length}/${result.cases.length} cases reproduced by ${result.model ?? opts.harness} alone${result.retired ? "; procedure retired" : ""}`, ...result.cases.map((c) => `  ${c.pass ? "pass" : "FAIL"}\t${c.file}\texpected ${JSON.stringify(c.expected)}\tgot ${JSON.stringify(c.got)}`)].join("\n"), result);
      }),
  );

program
  .command("resolve [text...]")
  .description("resolution ladder for a cell: cached decision, trusted procedure, or agent work")
  .option("--unit <u>")
  .option("--field <f>")
  .action((text: string[], opts: { unit?: string; field?: string }) => {
    const db = ensureIndex(root());
    const res = resolveLadder(db, opts.unit, opts.field, text.join(" "));
    db.close();
    print([`mode: ${res.mode}`, res.advice, res.precedents.length ? `precedents: ${res.precedents.map((p) => `${p.id} (${p.title})`).join("; ")}` : ""].filter(Boolean).join("\n"), res);
  });

program
  .command("kpi")
  .description("how the store is doing: resolutions without agent, decisions by status, procedure transitions per session")
  .action(() => {
    const db = ensureIndex(root());
    const k = kpi(db);
    db.close();
    print(renderKpi(k), k);
  });

program
  .command("render")
  .description("write review.html: KPIs, items to review, timeline by prompt, procedures, warnings")
  .option("--out <path>", "output file (default <store>/review.html)")
  .action((opts: { out?: string }) => {
    const r = root();
    const out = opts.out ? resolve(opts.out) : join(r, "review.html");
    writeText(out, renderReview(r));
    print(`wrote ${out}`, { path: out });
  });

program
  .command("export <dest>")
  .description("export the store for handoff: clone, manifest with integrity hashes, review page, derived output")
  .option("--no-history", "shallow export without git history (the manifest says so)")
  .action((dest: string, opts: { history: boolean }) => {
    const m = exportStore(root(), dest, { history: opts.history });
    print(`exported ${m.store_id} (${m.nodes} nodes, ${Object.keys(m.files).length} files hashed, history ${m.history_included ? "included" : "excluded"}) to ${resolve(dest)}`, m);
  });

program
  .command("check")
  .description("first-open check of a store: manifest integrity, artifacts, validation, index")
  .action(() => {
    const r = checkStore(root());
    print(
      [
        `${r.ok ? "ok" : "PROBLEMS"}: ${r.nodes} nodes, ${r.validation_errors} validation errors, ${r.validation_warnings} warnings`,
        r.manifest_found ? `manifest from ${r.exported_at} (history ${r.history_included ? "included" : "excluded"}): ${r.mismatched.length} mismatched, ${r.missing.length} missing, ${r.extra.length} new files` : "no manifest (not an export)",
        r.artifacts_missing.length ? `artifacts missing: ${r.artifacts_missing.join(", ")}` : "all artifacts present",
        ...r.mismatched.map((f) => `  mismatched ${f}`),
        ...r.missing.map((f) => `  missing ${f}`),
      ].join("\n"),
      r,
    );
    if (!r.ok) process.exitCode = 2;
  });

program
  .command("branch")
  .description("per-parent branches of a child store")
  .addCommand(
    new Command("open").requiredOption("--parent <id>", "parent store id").description("create or reuse parent/<id> with its worktree, rebased on main").action((opts: { parent: string }) => {
      const r = openParentBranch(root(), opts.parent);
      print(`${r.branch} at ${r.worktree}${r.created ? " (created)" : ""}${r.rebased ? ` (rebased, was ${r.behind_before} behind)` : ""}`, r);
    }),
  )
  .addCommand(
    new Command("status").description("parent branches with ahead/behind counts").action(() => {
      const rows = branchStatus(root());
      print(rows.map((r) => `${r.branch}\tahead ${r.ahead}\tbehind ${r.behind}\t${r.worktree ?? "-"}`).join("\n") || "(no parent branches)", rows);
    }),
  )
  .addCommand(
    new Command("merge").argument("<parent>").description("reconcile parent/<id> into main; conflicts abort and are listed").action((parent: string) => {
      const r = mergeParentBranch(root(), parent);
      print(r.merged ? `merged ${r.commits} commit(s) from ${r.branch}` : `${r.branch} has nothing to merge`, r);
    }),
  );

program
  .command("ask <question...>")
  .description("ask a coding agent a question about this store; it answers from CLI queries and cites record ids")
  .option("--harness <h>", "claude | codex | stub", "claude")
  .option("--model <m>", "model override for the harness")
  .option("--budget <usd>", "spending cap for the agent", "3")
  .action((question: string[], opts: { harness: string; model?: string; budget: string }) => {
    const r = askStore(root(), question.join(" "), { harness: opts.harness as RunnerHarness, model: opts.model ?? null, budgetUsd: Number(opts.budget) });
    print([r.answer, `records: ${r.records.join(", ") || "none"}`, `confidence: ${r.confidence}`].join("\n"), r);
  });

program
  .command("delegate")
  .description("delegate a question to a child store: its agent works on this store's branch and the answer comes back as evidence")
  .requiredOption("--child <id-or-dir>", "child store: a directory or an id registered under stores: in autosoft.yaml")
  .requiredOption("--question <text>", "what the child must find out")
  .option("--why <text>", "why it matters to this store", "")
  .option("--inputs <ids...>", "record ids or paths the child should start from")
  .option("--harness <h>", "claude | codex | stub", "claude")
  .option("--model <m>", "model override for the harness")
  .option("--budget <usd>", "spending cap for the child agent", "10")
  .action((opts: { child: string; question: string; why: string; inputs?: string[]; harness: string; model?: string; budget: string }) => {
    const r = root();
    const child = childRootFor(r, opts.child);
    const result = delegateTask(r, child, { question: opts.question, why: opts.why, inputs: opts.inputs ?? [], harness: opts.harness as RunnerHarness, model: opts.model ?? null, budgetUsd: Number(opts.budget) });
    printWarnings();
    print(
      [
        `task ${result.task.id} -> ${result.child_store} on ${result.branch} (${result.worktree})`,
        `child: ${result.output ? `${result.output.status}: ${result.output.result}` : "no structured output"}`,
        result.output?.decision_ids.length ? `child decisions: ${result.output.decision_ids.join(", ")}` : "",
        `parent episode ${result.parent_episode}, evidence ${result.parent_evidence}, artifact ${result.parent_artifact}`,
      ]
        .filter(Boolean)
        .join("\n"),
      result,
    );
  });

program
  .command("gc")
  .description("compact cold episode subtrees nothing live depends on into template nodes; git history keeps the raw files")
  .option("--apply", "apply the plan (default: print it)")
  .option("--cold-after <n>", "sessions of age after which a closed subtree is cold (default from autosoft.yaml)")
  .action((opts: { apply?: boolean; coldAfter?: string }) => {
    const r = root();
    const plan = planGc(loadStore(r), { coldAfter: opts.coldAfter !== undefined ? Number(opts.coldAfter) : undefined });
    if (!opts.apply) {
      print([`plan: ${plan.sweep.length} record(s) in ${plan.templates.length} subtree(s) would be compacted (cold after ${plan.cold_after_sessions} sessions; ${plan.live} live records stay)`, ...plan.sweep.map((s) => `  ${s.type}\t${s.id}\t${s.title}\t${s.reason}`)].join("\n"), plan);
      return;
    }
    const result = applyGc(r, plan);
    print(result.swept ? `compacted ${result.swept} record(s) into ${result.templates.join(", ")}${result.commit ? ` (commit ${result.commit.slice(0, 8)})` : ""}` : "nothing to compact", { plan, result });
  });

program
  .command("collapse <episode>")
  .description("collapse a parent episode whose children were all resolved deterministically into one composed procedure")
  .action((episode: string) => {
    const r = root();
    const result = collapseEpisode(loadStore(r), episode);
    printWarnings();
    print(`${result.procedure} composed from ${result.steps} step(s): ${result.entrypoint}`, result);
  });

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

/** The CLI contract: every command with its arguments and long options, recursively. */
interface ContractCommand {
  name: string;
  args: string[];
  options: string[];
}

function contractOf(cmd: Command, prefix = ""): ContractCommand[] {
  const out: ContractCommand[] = [];
  for (const sub of cmd.commands) {
    const name = `${prefix}${sub.name()}`;
    out.push({
      name,
      args: sub.registeredArguments.map((a) => (a.required ? `<${a.name()}${a.variadic ? "..." : ""}>` : `[${a.name()}${a.variadic ? "..." : ""}]`)),
      options: sub.options.map((o) => o.long ?? o.short ?? "").filter(Boolean).sort(),
    });
    out.push(...contractOf(sub, `${name} `));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface GateReport {
  snapshot: string;
  additive: string[];
  breaking: string[];
  ok: boolean;
}

function compareContracts(before: ContractCommand[], after: ContractCommand[]): Omit<GateReport, "snapshot" | "ok"> {
  const additive: string[] = [];
  const breaking: string[] = [];
  const byName = (list: ContractCommand[]) => new Map(list.map((c) => [c.name, c]));
  const b = byName(before);
  const a = byName(after);
  for (const [name, cmd] of b) {
    const now = a.get(name);
    if (!now) {
      breaking.push(`command removed: ${name}`);
      continue;
    }
    if (JSON.stringify(cmd.args) !== JSON.stringify(now.args)) breaking.push(`arguments of ${name} changed: ${cmd.args.join(" ")} -> ${now.args.join(" ")}`);
    for (const o of cmd.options) if (!now.options.includes(o)) breaking.push(`option removed: ${name} ${o}`);
    for (const o of now.options) if (!cmd.options.includes(o)) additive.push(`option added: ${name} ${o}`);
  }
  for (const name of a.keys()) if (!b.has(name)) additive.push(`command added: ${name}`);
  return { additive, breaking };
}

program
  .command("gate")
  .description("compare the CLI contract with the committed snapshot: additive changes pass, removals and renames fail")
  .option("--snapshot", "write the current contract as the new snapshot")
  .option("--against <file>", "compare with a specific snapshot file", join(TOOL_ROOT, "contract.json"))
  .action((opts: { snapshot?: boolean; against: string }) => {
    const current = contractOf(program);
    if (opts.snapshot) {
      writeText(opts.against, `${JSON.stringify(current, null, 2)}\n`);
      print(`snapshot written: ${current.length} commands -> ${opts.against}`, { snapshot: opts.against, commands: current.length });
      return;
    }
    if (!existsSync(opts.against)) throw new CliError(`no snapshot at ${opts.against}; run autosoft gate --snapshot`, 1);
    const before = JSON.parse(readText(opts.against)) as ContractCommand[];
    const cmp = compareContracts(before, current);
    const report: GateReport = { snapshot: opts.against, ...cmp, ok: cmp.breaking.length === 0 };
    print([report.ok ? "ok: no breaking change" : "BREAKING changes", ...cmp.breaking.map((s) => `  breaking: ${s}`), ...cmp.additive.map((s) => `  additive: ${s}`)].join("\n"), report);
    if (!report.ok) process.exitCode = 1;
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
