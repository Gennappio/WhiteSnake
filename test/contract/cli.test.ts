import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURES, runCli, tempToy } from "../helpers.js";

const GOLDEN_DIR = join(FIXTURES, "toy-golden");
const UPDATE = process.env["UPDATE_GOLDENS"] === "1";

function golden(name: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE || !existsSync(file)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, text);
    if (!UPDATE) assert.fail(`golden ${name} did not exist; written, re-run the tests`);
    return;
  }
  assert.equal(text, readFileSync(file, "utf8"), `golden mismatch for ${name} (set UPDATE_GOLDENS=1 to accept)`);
}

test("the toy store validates and the index rebuild is byte-identical", () => {
  const { dir, cleanup } = tempToy();
  try {
    const v = runCli(["--json", "validate"], { cwd: dir });
    assert.equal(v.status, 0, v.stdout);
    const d1 = runCli(["index", "--dump"], { cwd: dir }).stdout;
    rmSync(join(dir, ".autosoft"), { recursive: true, force: true });
    const d2 = runCli(["index", "--dump"], { cwd: dir }).stdout;
    assert.ok(d1.length > 1000);
    assert.equal(d1, d2);
  } finally {
    cleanup();
  }
});

test("why, affected, precedent, frontier and timeline match the goldens", () => {
  const { dir, cleanup } = tempToy();
  try {
    golden("why-P01-n_analyzed_total", runCli(["--json", "why", "P01/n_analyzed_total"], { cwd: dir }).json);
    golden("why-decision-id", runCli(["--json", "why", "dec_p01nrand0000"], { cwd: dir }).json);
    golden("affected-criterion-analyzed", runCli(["--json", "affected", "dec_crit0analyz1"], { cwd: dir }).json);
    golden("affected-procedure", runCli(["--json", "affected", "proc_tablecount01"], { cwd: dir }).json);
    golden("affected-artifact-P01", runCli(["--json", "affected", "art_p01a7k3m9q2x"], { cwd: dir }).json);
    golden("precedent-itt", runCli(["--json", "precedent", "ITT", "per-protocol", "analysed", "population"], { cwd: dir }).json);
    golden("frontier", runCli(["--json", "frontier"], { cwd: dir }).json);
    golden("timeline", runCli(["--json", "timeline"], { cwd: dir }).json);
    golden("ls-decisions", runCli(["--json", "ls", "decision"], { cwd: dir }).json);
  } finally {
    cleanup();
  }
});

test("affected of the ITT criterion is exactly the analysed-count annotation and its episode chain", () => {
  const { dir, cleanup } = tempToy();
  try {
    const rows = runCli(["--json", "affected", "dec_crit0analyz1"], { cwd: dir }).json as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id).sort(), ["dec_p01nanal0000", "ep_p01nanal0000", "ep_p01root00000"]);
    const randomised = runCli(["--json", "affected", "dec_crit0random2"], { cwd: dir }).json as { id: string }[];
    assert.ok(randomised.some((r) => r.id === "dec_p01nrand0000"));
    assert.ok(!randomised.some((r) => r.id === "dec_p01nanal0000"));
  } finally {
    cleanup();
  }
});

test("precedent ranks the ITT criterion first for an ITT question", () => {
  const { dir, cleanup } = tempToy();
  try {
    const rows = runCli(["--json", "precedent", "intention-to-treat", "analysed", "population", "per-protocol"], { cwd: dir }).json as { id: string }[];
    assert.equal(rows[0]?.id, "dec_crit0analyz1");
  } finally {
    cleanup();
  }
});

const corruptions: { name: string; code: string; apply: (dir: string) => void }[] = [
  {
    name: "dangling edge",
    code: "E_DANGLING_EDGE",
    apply: (dir) => {
      const p = join(dir, "knowledge", "decisions", "dec_p01nanal0000.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("ev_p01table1000", "ev_doesnotexist"));
    },
  },
  {
    name: "edge to the wrong node type",
    code: "E_WRONG_TARGET_TYPE",
    apply: (dir) => {
      const p = join(dir, "knowledge", "decisions", "dec_p01nanal0000.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("  - ev_p01table1000", "  - dec_crit0random2"));
    },
  },
  {
    name: "duplicate id",
    code: "E_DUPLICATE_ID",
    apply: (dir) => {
      const src = join(dir, "knowledge", "questions", "q_figonly00001.md");
      writeFileSync(join(dir, "knowledge", "questions", "q_zzzzzzzzzzzz.md"), readFileSync(src, "utf8"));
    },
  },
  {
    name: "missing claim",
    code: "E_SCHEMA",
    apply: (dir) => {
      const p = join(dir, "knowledge", "decisions", "dec_crit0outcom3.md");
      writeFileSync(p, readFileSync(p, "utf8").replace(/^claim: .*$/m, ""));
    },
  },
  {
    name: "procedure state cache disagrees with history",
    code: "E_STATE_MISMATCH",
    apply: (dir) => {
      const p = join(dir, "knowledge", "procedures", "proc_tablecount01.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("state: provisional", "state: trusted"));
    },
  },
  {
    name: "unknown node type directory",
    code: "E_UNKNOWN_TYPE",
    apply: (dir) => {
      mkdirSync(join(dir, "knowledge", "facts"));
      writeFileSync(join(dir, "knowledge", "facts", "x.md"), "---\ntype: fact\n---\n");
    },
  },
  {
    name: "evidence body tampered",
    code: "E_HASH_MISMATCH",
    apply: (dir) => {
      const p = join(dir, "knowledge", "evidence", "ev_p01table1000.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("| 60 | 58 |", "| 60 | 59 |"));
    },
  },
];

for (const c of corruptions) {
  test(`validate reports ${c.code} for a ${c.name} and exits 2`, () => {
    const { dir, cleanup } = tempToy();
    try {
      c.apply(dir);
      const r = runCli(["--json", "validate"], { cwd: dir });
      assert.equal(r.status, 2);
      const issues = (r.json as { issues: { code: string }[] }).issues;
      assert.ok(issues.some((i) => i.code === c.code), `expected ${c.code}, got ${issues.map((i) => i.code).join(",")}`);
    } finally {
      cleanup();
    }
  });
}

test("add, set and link write valid records and reject bad references", () => {
  const { dir, cleanup } = tempToy();
  try {
    const ep = runCli(["--json", "add", "episode", "--json-in", JSON.stringify({ title: "Annotate P02", resolution: "agent" }), "--actor", "test"], { cwd: dir });
    assert.equal(ep.status, 0, ep.stdout);
    const epId = (ep.json as { id: string }).id;
    const ev = runCli(["--json", "add", "evidence", "--json-in", JSON.stringify({ title: "P02 Table 1", kind: "excerpt", locator: { artifact: "art_p02b8n4p0r5y", table: "Table 1" }, produced_by: epId }), "--body", "| Aquatic exercise | 42 | 41 |"], { cwd: dir });
    assert.equal(ev.status, 0, ev.stdout);
    const evId = (ev.json as { id: string; hash: string }).id;
    assert.match((ev.json as { hash: string }).hash, /^[0-9a-f]{64}$/);
    const bad = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: "x", kind: "annotation", claim: "c", qualifier: { confidence: 0.5 }, fragility: "mechanical", target: { unit: "P02", field: "n_randomized_total", value: 84 }, data: ["ev_nope00000000"], warrant: ["dec_p01nrand0000"] })], { cwd: dir });
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /E_DANGLING_EDGE/);
    assert.match(bad.stdout, /E_WARRANT_NOT_CRITERION/);
    const dec = runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: "P02 n_randomized_total", kind: "annotation", status: "active", claim: "84 randomised", qualifier: { confidence: 0.9, scope: "P02" }, fragility: "mechanical", target: { unit: "P02", field: "n_randomized_total", value: 84 }, data: [evId], warrant: ["dec_crit0random2"], produced_by: epId })], { cwd: dir });
    assert.equal(dec.status, 0, dec.stdout);
    const decId = (dec.json as { id: string }).id;
    const closed = runCli(["--json", "set", epId, "--json-in", JSON.stringify({ outcome: "success", ended: "2026-10-16T10:00:00.000Z", produces: [evId, decId] })], { cwd: dir });
    assert.equal(closed.status, 0, closed.stdout);
    const linked = runCli(["--json", "link", decId, "backing", "dec_choice0tabl4"], { cwd: dir });
    assert.equal(linked.status, 0, linked.stdout);
    const why = runCli(["--json", "why", "P02/n_randomized_total"], { cwd: dir }).json as { id: string; children: { rel: string }[] };
    assert.equal(why.id, decId);
    assert.ok(why.children.some((c) => c.rel === "data") && why.children.some((c) => c.rel === "warrant") && why.children.some((c) => c.rel === "produced_by"));
    assert.equal(runCli(["validate"], { cwd: dir }).status, 0);
    const csv = runCli(["--json", "export-output"], { cwd: dir });
    assert.equal(csv.status, 0);
    assert.match(readFileSync(join(dir, "output", "annotations.csv"), "utf8"), /P02,84/);
  } finally {
    cleanup();
  }
});

test("declared citations are authoritative: a coarse episode does not spread a criterion change to decisions that cite other warrants", () => {
  const { dir, cleanup } = tempToy();
  try {
    const ep = (runCli(["--json", "add", "episode", "--json-in", JSON.stringify({ title: "Annotate P02 (coarse)", resolution: "agent", uses: ["dec_crit0analyz1", "dec_crit0random2", "dec_crit0outcom3"] })], { cwd: dir }).json as { id: string }).id;
    const ev = (runCli(["--json", "add", "evidence", "--json-in", JSON.stringify({ title: "P02 Table 1", kind: "excerpt", locator: { artifact: "art_p02b8n4p0r5y" }, produced_by: ep }), "--body", "| Aquatic exercise | 42 | 41 |"], { cwd: dir }).json as { id: string }).id;
    const mk = (field: string, value: number, warrant: string[]) =>
      runCli(["--json", "add", "decision", "--json-in", JSON.stringify({ title: `P02 ${field}`, kind: "annotation", status: "active", claim: "c", qualifier: { confidence: 0.9 }, fragility: "mechanical", target: { unit: "P02", field, value }, data: [ev], warrant, produced_by: ep })], { cwd: dir });
    const rand = mk("n_randomized_total", 84, ["dec_crit0random2"]);
    assert.equal(rand.status, 0, rand.stdout);
    assert.match(rand.stderr, /W_UNCITED_CRITERION/);
    const anal = (mk("n_analyzed_total", 80, ["dec_crit0analyz1"]).json as { id: string }).id;
    const bare = (mk("primary_outcome", 0, []).json as { id: string }).id;
    const aff = (runCli(["--json", "affected", "dec_crit0analyz1"], { cwd: dir }).json as { id: string }[]).map((r) => r.id);
    assert.ok(aff.includes(anal), "the analysed decision cites the criterion");
    assert.ok(aff.includes(bare), "a decision without declared citations inherits the episode's uses");
    assert.ok(!aff.includes((rand.json as { id: string }).id), "a decision citing another warrant is not flagged");
    const v = runCli(["--json", "validate"], { cwd: dir });
    assert.equal(v.status, 0);
    const warnings = (v.json as { warnings: { code: string }[] }).warnings.map((w) => w.code);
    assert.ok(warnings.includes("W_UNCITED_CRITERION"));
  } finally {
    cleanup();
  }
});
