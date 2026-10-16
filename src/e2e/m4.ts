/**
 * M4 live test: sublation with a real model.
 *
 *   1. a fresh toy store; `procedure recheck proc_tablecount01 --retire`: the model alone must reproduce the P01 sum (120)
 *      and the procedure is retired;
 *   2. a second procedure whose regression case expects the sha256 of a corpus file: the model cannot compute it, so the
 *      procedure is kept;
 *   3. provenance of P01's decisions still resolves to the retired procedure; `frontier` and `kpi` show the retirement.
 *
 *   node dist/src/e2e/m4.js [--harness claude|codex] [--model M] [--keep]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, cli, parseCommonArgs, prepareStore, type CommonArgs } from "./common.js";

function main(): void {
  const args: CommonArgs = parseCommonArgs(process.argv.slice(2));
  const store = prepareStore("whitesnake-m4-");
  const harnessArgs = ["--harness", args.harness, ...(args.model ? ["--model", args.model] : [])];

  const easy = cli(store, ["procedure", "recheck", "proc_tablecount01", "--retire", ...harnessArgs]);
  const e = (easy.json ?? {}) as { all_pass?: boolean; retired?: boolean; cases?: { expected: unknown; got: unknown; pass: boolean }[] };
  console.error(`[m4] easy recheck: ${JSON.stringify(e.cases)} retired=${e.retired}`);

  const sha = createHash("sha256").update(readFileSync(join(store, "corpus", "P01.md"))).digest("hex");
  writeFileSync(join(store, "procedures", "table_counts", "cases", "sha.json"), JSON.stringify({ input: ["corpus/P01.md"], expected: sha }));
  const hardId = (cli(store, ["add", "procedure", "--json-in", JSON.stringify({ title: "Content hash of a corpus file", resolution: "code", entrypoint: "shasum -a 256", applicability: ["any file"], regression_cases: ["procedures/table_counts/cases/sha.json"] })]).json as { id: string }).id;
  const hard = cli(store, ["procedure", "recheck", hardId, "--retire", ...harnessArgs]);
  const h = (hard.json ?? {}) as { all_pass?: boolean; retired?: boolean; cases?: { expected: unknown; got: unknown; pass: boolean }[] };
  console.error(`[m4] hard recheck: pass=${h.all_pass} retired=${h.retired}`);

  const why = cli(store, ["why", "P01/n_randomized_total"]).json as { children: { rel: string; node: { id: string; status?: string; children: { rel: string; node: { id: string; status?: string } }[] } }[] } | null;
  const producedBy = why?.children.find((c) => c.rel === "produced_by")?.node;
  const stillCited = producedBy?.children.some((c) => c.rel === "uses" && c.node.id === "proc_tablecount01" && c.node.status === "retired") ?? false;
  const kpi = cli(store, ["kpi"]).json as { procedures: { by_state: Record<string, number> }; transitions: { to: string }[] };
  const report = {
    store,
    harness: args.harness,
    model: args.model,
    easy: { all_pass: e.all_pass ?? false, retired: e.retired ?? false, cases: e.cases ?? [] },
    hard: { all_pass: h.all_pass ?? false, retired: h.retired ?? false, cases: h.cases ?? [] },
    provenance_resolves_to_retired: stillCited,
    procedures_by_state: kpi.procedures.by_state,
    validate_ok: cli(store, ["validate"]).status === 0,
    pass: (e.retired ?? false) && !(h.retired ?? false) && stillCited && cli(store, ["validate"]).status === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nM4 live test (${args.harness}): ${report.pass ? "PASS" : "FAIL"}  easy retired=${report.easy.retired} hard kept=${!report.hard.retired} provenance=${stillCited} states=${JSON.stringify(report.procedures_by_state)}`);
  cleanup(store, args.keep);
  process.exitCode = report.pass ? 0 : 1;
}

main();
