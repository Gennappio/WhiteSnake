/**
 * Generates examples/toy-store deterministically from examples/toy-corpus.
 * Fixed ids and timestamps make the store a stable fixture for tests and goldens.
 * Usage: node dist/src/tools/make-toy.js [target-dir]
 */
import { cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "../schema/nodes.js";
import { TYPE_DIR } from "../schema/ids.js";
import { writeConfig } from "../store/config.js";
import { loadStore, writeNodeFile } from "../store/files.js";
import { validateStore } from "../store/validate.js";
import { canonicalBody, ensureDir, sha256, writeText } from "../util.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(here, "..", "..", "..");
const CORPUS_SRC = join(TOOL_ROOT, "examples", "toy-corpus");
const target = resolve(process.argv[2] ?? join(TOOL_ROOT, "examples", "toy-store"));

const T0 = "2026-10-01T09:00:00.000Z";
const T1 = "2026-10-01T09:05:00.000Z";
const T2 = "2026-10-01T09:20:00.000Z";
const T3 = "2026-10-01T09:40:00.000Z";
const SEED_SESSION = "toyseed0001";
const SES = `ses_claude_${SEED_SESSION}`;
const TURN1 = `turn_claude_${SEED_SESSION}_0001`;
const TURN2 = `turn_claude_${SEED_SESSION}_0002`;
const ACTOR = "fixture:make-toy";

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
ensureDir(target);
for (const d of Object.values(TYPE_DIR)) {
  ensureDir(join(target, "knowledge", d));
  writeText(join(target, "knowledge", d, ".gitkeep"), "");
}
for (const d of ["corpus", "procedures/table_counts/cases", "artifacts", "output", ".autosoft"]) ensureDir(join(target, d));
cpSync(CORPUS_SRC, join(target, "corpus"), { recursive: true });
writeText(join(target, ".gitignore"), ".autosoft/\noutput/*.sqlite\n.DS_Store\n");

writeConfig(target, {
  id: "toy",
  name: "Toy trial annotation store",
  schema_version: 1,
  mandate:
    "Annotate the synthetic trial reports in corpus/ with the fields in output.fields. Count the intention-to-treat analysed population. Cite the table or sentence each value comes from.",
  harness: "claude",
  model: null,
  corpus: ["corpus"],
  output: {
    unit: "paper",
    fields: [
      { name: "n_randomized_total", type: "integer", description: "Participants randomised, summed over arms" },
      { name: "n_analyzed_total", type: "integer", description: "Participants analysed for the primary outcome (ITT population), summed over arms" },
      { name: "primary_outcome", type: "string", description: "Prespecified primary outcome measure, as named by the paper" },
    ],
  },
});

const bodies = new Map<string, string>();
const nodes: Node[] = [];
const add = (n: Node, body = ""): void => {
  nodes.push(n);
  bodies.set(n.id, body);
};
const base = (id: string, title: string, created: string) => ({ id, title, created, created_by: ACTOR });

// Session and turns of the seeding researcher session
add({ ...base(SES, "Claude Code session toyseed0", T0), type: "session", harness: "claude", native_id: SEED_SESSION, cwd: "/toy", git_branch: "main", log_path: null, model: "fixture", started: T0, ended: T3 });
const prompt1 = "Annotate P01 following the output schema in autosoft.yaml. Cite the table each count comes from.";
const prompt2 = "When a paper reports both intention-to-treat and per-protocol analysed counts, count the intention-to-treat population.";
add({ ...base(TURN1, `Turn 1: ${prompt1.slice(0, 60)}`, T0), type: "turn", session: SES, index: 1, native_id: null, prompt_excerpt: prompt1, prompt_hash: sha256(prompt1), timestamp: T0 }, prompt1);
add({ ...base(TURN2, `Turn 2: ${prompt2.slice(0, 60)}`, T1), type: "turn", session: SES, index: 2, native_id: null, prompt_excerpt: prompt2, prompt_hash: sha256(prompt2), timestamp: T1 }, prompt2);

// Artifacts: one per corpus file
const artIds: Record<string, string> = { P01: "art_p01a7k3m9q2x", P02: "art_p02b8n4p0r5y", P03: "art_p03c9m5q1s6z" };
for (const [paper, id] of Object.entries(artIds)) {
  const rel = `corpus/${paper}.md`;
  const abs = join(target, rel);
  add({ ...base(id, `${paper} report (markdown)`, T0), type: "artifact", sha256: sha256(readFileSync(abs)), path: rel, source_uri: null, mime: "text/markdown", size: statSync(abs).size, caused_by: TURN1 });
}

// Questions
const Q1 = "q_ittvspp00001";
const Q2 = "q_figonly00001";
add({ ...base(Q1, "Which analysed population counts when both ITT and per-protocol are reported?", T0), type: "question", status: "answered", why: "n_analyzed_total would differ by the number of protocol deviators; the choice must be uniform across papers.", raised_in: "ep_p01root00000", answered_by: ["dec_crit0analyz1"], caused_by: TURN1 },
  "Raised while reading P01 methods, which mention a per-protocol sensitivity analysis.");
add({ ...base(Q2, "How should counts be recorded when they appear only in a figure?", T2), type: "question", status: "open", why: "The table_counts procedure cannot read figures; a human reading or a different procedure is needed.", raised_in: null, answered_by: [], caused_by: TURN2 },
  "Not yet encountered in the corpus. Left open on purpose.");

// Criteria (decisions of kind criterion) and a methodological choice
const C_ANALYZED = "dec_crit0analyz1";
const C_RANDOM = "dec_crit0random2";
const C_OUTCOME = "dec_crit0outcom3";
const CHOICE_TABLE = "dec_choice0tabl4";
const crit = (id: string, title: string, claim: string, scope: string, created: string, causedBy: string, rebuttal: string, answers: string | null = null): Node => ({
  ...base(id, title, created), type: "decision", kind: "criterion", status: "active", claim, qualifier: { confidence: 1, scope }, fragility: "mechanical", target: null,
  data: [], warrant: [], backing: [], rebuttal: { text: rebuttal, evidence: [] }, depends_on: [], supersedes: [], answers, produced_by: null, caused_by: causedBy, shown_at: [],
});
add(crit(C_ANALYZED, "Criterion: analysed population is the ITT population", "n_analyzed_total counts participants in the intention-to-treat analysis of the primary outcome, summed over arms; per-protocol counts are not used.", "all papers in this store", T1, TURN2, "Does not apply if a paper reports no ITT analysis at all; then record the analysed population it reports and lower confidence.", Q1),
  "Set by the researcher in turn 2 after P01 raised the ITT versus per-protocol question.");
add(crit(C_RANDOM, "Criterion: randomised total is the sum of randomised per arm", "n_randomized_total is the number of participants randomised, summed over arms, taken from the participant flow table when present.", "all papers in this store", T0, TURN1, "If the flow table and the abstract disagree, the table wins (see the table-first choice) and the disagreement is recorded as evidence."),
  "Stated in the mandate; made explicit as a criterion so annotations can cite it.");
add(crit(C_OUTCOME, "Criterion: primary outcome is the prespecified measure as named", "primary_outcome is the prespecified primary outcome measure named in the methods, including instrument and time point when stated.", "all papers in this store", T0, TURN1, "If the paper names more than one primary outcome, record all, separated by semicolons, and raise a question."),
  "Stated in the mandate.");
add({ ...base(CHOICE_TABLE, "Choice: tables are the source of counts when prose and tables disagree", T0), type: "decision", kind: "choice", status: "active", claim: "When the prose and a participant-flow table disagree on counts, the table is used and the disagreement is recorded as evidence.", qualifier: { confidence: 0.9, scope: "all papers in this store" }, fragility: "interpretive", target: null, data: [], warrant: [], backing: [], rebuttal: { text: "A table with an obvious arithmetic error (arms not summing to the total) is not trusted over the prose.", evidence: [] }, depends_on: [], supersedes: [], answers: null, produced_by: null, caused_by: TURN1, shown_at: [] },
  "Methodological choice made while annotating P01; tables are structured and less prone to rounding in prose.");

// Procedure: sum table columns
const PROC = "proc_tablecount01";
writeText(join(target, "procedures", "table_counts", "run.py"), `#!/usr/bin/env python3
"""Sum a numeric column of the first markdown table in a file, excluding any row labelled Total.

Usage: run.py <markdown-file> <column-header-substring>
Prints JSON: {"column": ..., "rows": [[arm, value], ...], "total": n}
"""
import json
import re
import sys


def main() -> int:
    path, wanted = sys.argv[1], sys.argv[2].lower()
    rows = [l.strip() for l in open(path, encoding="utf-8") if l.strip().startswith("|")]
    if len(rows) < 2:
        print(json.dumps({"error": "no markdown table found"}))
        return 2
    header = [c.strip() for c in rows[0].strip("|").split("|")]
    idx = next((i for i, h in enumerate(header) if wanted in h.lower()), None)
    if idx is None:
        print(json.dumps({"error": f"no column matching {wanted!r}", "header": header}))
        return 2
    out, total = [], 0
    for line in rows[2:]:
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells or cells[0].lower() == "total":
            continue
        m = re.search(r"-?\\d+", cells[idx]) if idx < len(cells) else None
        if not m:
            continue
        value = int(m.group())
        out.append([cells[0], value])
        total += value
    print(json.dumps({"column": header[idx], "rows": out, "total": total}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`);
writeText(join(target, "procedures", "table_counts", "cases", "p01.json"), `${JSON.stringify({ input: ["corpus/P01.md", "Randomised"], expected_total: 120 }, null, 2)}\n`);
add({ ...base(PROC, "Sum a column of the participant-flow table", T2), type: "procedure", state: "provisional", resolution: "code", entrypoint: "procedures/table_counts/run.py", uses: [CHOICE_TABLE], applicability: ["the paper has a markdown table with per-arm rows and a column whose header contains the wanted word (Randomised, Analysed)"], abstain_when: ["counts appear only in prose or in a figure", "the table has merged or multi-line cells"], regression_cases: ["procedures/table_counts/cases/p01.json"], promoted_from: ["ep_p01nrand0000", "ep_p01nanal0000"], qualified_on: { harness: "claude", model: "fixture" }, history: [{ at: T2, from: null, to: "provisional", caused_by: TURN1, reason: "written while annotating P01 and reused for both count fields" }], counters: { shown_uses: 1, corrections: 0 }, produced_by: "ep_p01root00000", caused_by: TURN1 },
  "Run: python3 procedures/table_counts/run.py corpus/P0X.md Randomised\nOutput JSON has rows per arm and the total excluding any Total row. Record the output as execution evidence.");

// Episodes for P01
const EP_ROOT = "ep_p01root00000";
const EP_RAND = "ep_p01nrand0000";
const EP_ANAL = "ep_p01nanal0000";
const EP_OUT = "ep_p01outcm0000";
const EV_TABLE = "ev_p01table1000";
const EV_OUTCOME = "ev_p01outcome00";
const EV_EXEC = "ev_p01execrand0";
const D_RAND = "dec_p01nrand0000";
const D_ANAL = "dec_p01nanal0000";
const D_OUT = "dec_p01outcm0000";
const ep = (id: string, title: string, parent: string | null, resolution: "agent" | "code", uses: string[], produces: string[], children: string[], created: string): Node => ({
  ...base(id, title, created), type: "episode", question: null, parent, resolution, uses, produces, children, outcome: "success", input_hash: null, started: created, ended: T3, caused_by: TURN1,
});
add(ep(EP_ROOT, "Annotate P01", null, "agent", [C_RANDOM, C_ANALYZED, C_OUTCOME], [Q1, PROC], [EP_RAND, EP_ANAL, EP_OUT], T0), "Read P01, extracted Table 1, wrote the table_counts script, annotated the three fields. Raised the ITT versus per-protocol question; answered by the researcher in turn 2.");
add(ep(EP_RAND, "P01 n_randomized_total", EP_ROOT, "code", [PROC, C_RANDOM], [EV_TABLE, EV_EXEC, D_RAND], [], T2));
add(ep(EP_ANAL, "P01 n_analyzed_total", EP_ROOT, "code", [PROC, C_ANALYZED], [D_ANAL], [], T2));
add(ep(EP_OUT, "P01 primary_outcome", EP_ROOT, "agent", [C_OUTCOME], [EV_OUTCOME, D_OUT], [], T2));

// Evidence for P01
const tableExcerpt = "| Arm | Randomised | Analysed (ITT) |\n|---|---|---|\n| Early mobilisation | 60 | 58 |\n| Usual care | 60 | 57 |\n| Total | 120 | 115 |";
const outcomeExcerpt = "The prespecified primary outcome was the Timed Up and Go test (seconds) at 30 days after surgery.";
const execOutput = '{"column": "Randomised", "rows": [["Early mobilisation", 60], ["Usual care", 60]], "total": 120}';
const ev = (id: string, title: string, kind: "excerpt" | "observation" | "execution", body: string, locator: Record<string, unknown>, producedBy: string): Node => ({
  ...base(id, title, T2), type: "evidence", kind, locator: { artifact: artIds["P01"]!, path: null, page: null, table: null, section: null, span: null, ...locator }, hash: sha256(canonicalBody(body)), produced_by: producedBy, caused_by: TURN1,
});
add(ev(EV_TABLE, "P01 Table 1 participant flow", "excerpt", tableExcerpt, { table: "Table 1", section: "Results" }, EP_RAND), tableExcerpt);
add(ev(EV_OUTCOME, "P01 primary outcome sentence", "excerpt", outcomeExcerpt, { section: "Methods / Outcomes" }, EP_OUT), outcomeExcerpt);
add(ev(EV_EXEC, "table_counts output for P01 Randomised", "execution", execOutput, { section: "procedures/table_counts/run.py corpus/P01.md Randomised" }, EP_RAND), execOutput);

// Annotation decisions for P01
const ann = (id: string, title: string, field: string, value: string | number, claim: string, data: string[], warrant: string[], fragility: "mechanical" | "interpretive", producedBy: string, backing: string[] = []): Node => ({
  ...base(id, title, T3), type: "decision", kind: "annotation", status: "active", claim, qualifier: { confidence: 0.95, scope: "P01" }, fragility, target: { unit: "P01", field, value },
  data, warrant, backing, rebuttal: { text: "", evidence: [] }, depends_on: [], supersedes: [], answers: null, produced_by: producedBy, caused_by: TURN1, shown_at: [TURN2],
});
add(ann(D_RAND, "P01 n_randomized_total", "n_randomized_total", 120, "120 participants were randomised (60 early mobilisation + 60 usual care).", [EV_TABLE, EV_EXEC], [C_RANDOM], "mechanical", EP_RAND, [CHOICE_TABLE]), "Table 1 total row and the procedure output agree.");
add(ann(D_ANAL, "P01 n_analyzed_total", "n_analyzed_total", 115, "115 participants were analysed in the ITT population (58 + 57).", [EV_TABLE], [C_ANALYZED], "mechanical", EP_ANAL), "Table 1 reports the ITT analysed column; five lost to follow-up are excluded, consistent with the Results text.");
add(ann(D_OUT, "P01 primary_outcome", "primary_outcome", "Timed Up and Go test (seconds) at 30 days", "The prespecified primary outcome is the Timed Up and Go test in seconds at 30 days after surgery.", [EV_OUTCOME], [C_OUTCOME], "mechanical", EP_OUT), "Verbatim from Methods / Outcomes.");

for (const n of nodes) writeNodeFile(target, n, bodies.get(n.id) ?? "");

const issues = validateStore(loadStore(target));
if (issues.length) {
  console.error(JSON.stringify(issues, null, 2));
  process.exit(2);
}
console.log(`toy store written to ${target}: ${nodes.length} nodes, valid`);
