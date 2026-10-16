---
name: whitesnake
description: Work inside an WhiteSnake knowledge store (a directory containing whitesnake.yaml). Use whenever you annotate, decide, explain, correct or re-examine results in such a store, or when the user mentions whitesnake, provenance, precedents, decisions, evidence or procedures. Teaches how to consult precedents first, record every decision with its evidence through the whitesnake CLI, register reusable procedures, and never edit knowledge/ files by hand.
---

# WhiteSnake store

An WhiteSnake store turns research work into something another person or agent can inherit: every value you produce is a **decision** that cites **evidence** (verbatim excerpts with exact locators) and a **criterion** (the rule that licenses it), and records which **prompt** caused it. The store is plain files under `knowledge/`, validated and indexed by the `whitesnake` CLI. Read `whitesnake.yaml` for the mandate and the output fields.

The one rule that matters: **write to the store only through the CLI** (`whitesnake add`, `whitesnake set`, `whitesnake link`). Direct edits of `knowledge/**` are refused by a hook because they bypass validation.

## Workflow for a task

1. **Orient.** `whitesnake frontier` shows open questions and provisional work. `whitesnake precedent "<key words>"` finds earlier decisions, criteria and procedures on the same problem. Reuse them; do not re-derive. `whitesnake why <id>` explains any existing result.
2. **Open an episode** for the unit of work (one paper, one field, one check):
   `whitesnake add episode --json-in '{"title":"Annotate P02","resolution":"agent"}'` → prints `ep_…`. Nest sub-episodes with `"parent":"ep_…"`.
3. **Prefer existing procedures.** `whitesnake ls procedure` lists them with state and entrypoint. Run a `trusted` or `provisional` procedure instead of redoing the work by hand; record it in the episode's `uses`. Write new code only when none applies, save it under `procedures/<name>/`, and register it (see record-types).
   **Run commands whose output is evidence through the store:** `whitesnake run "python3 procedures/table_counts/run.py corpus/P02.md Randomised" --episode ep_…` executes the command and records it as execution evidence in one step (command, exit code, platform, hashes of the input files, output). No need to write a script for a one-off command. When the same command recurs across episodes, `whitesnake procedure propose --from-evidence ev_… ev_…` distils the recorded executions into a procedure skeleton with regression cases; refine its applicability and let shown uses promote it.
4. **Capture evidence before deciding.** For each fact you rely on:
   `whitesnake add evidence --json-in '{"title":"P02 Table 1","kind":"excerpt","locator":{"artifact":"art_…","section":"Table 1"},"produced_by":"ep_…"}' --body "<verbatim excerpt>"`
   Sources are `artifact` nodes (`whitesnake ls artifact`). If a source file has no artifact yet, add one with its sha256 (`shasum -a 256 <file>`).
5. **Record the decision** in Toulmin form (claim, data, warrant, backing, qualifier, rebuttal):
   `whitesnake add decision --json-in '{"title":"P02 n_randomized_total","kind":"annotation","status":"active","claim":"84 participants were randomised (42 + 42)","qualifier":{"confidence":0.95,"scope":"P02"},"fragility":"mechanical","target":{"unit":"P02","field":"n_randomized_total","value":84},"data":["ev_…"],"warrant":["dec_<criterion>"],"produced_by":"ep_…"}'`
   `warrant` must name criterion decisions (`whitesnake ls decision --kind criterion`). `data` must be evidence ids. `caused_by` is filled automatically with the current turn.
6. **Close the episode:** `whitesnake set ep_… --json-in '{"outcome":"success","ended":"<ISO time>","produces":["dec_…","ev_…"]}'`.
7. **Verify and report.** `whitesnake validate` must print `ok`. When you present results to the user, list the decision ids you created so they can be reviewed with `whitesnake why`.

## Rules

- **Consult before deciding.** Always run `precedent` before interpreting something; a matching criterion or decision is the answer, not a suggestion.
- **Separate what the source says, what you observed, what you decided.** Source text is `evidence` (verbatim). Your own measurement or script output is `evidence` of kind `observation` or `execution`. The interpretation is a `decision`.
- **Record at decision time with exact ids.** Never describe provenance in prose only.
- **Fill and flag, never stall.** If a criterion is missing or ambiguous, create a `question`, make the best decision with `"status":"proposed"` and a lower confidence, cite the question in `qualifier.scope`, and continue. The researcher resolves it later.
- **Mark fragility honestly.** `mechanical` when a criterion applies directly, `interpretive` when you chose among readings, `analogical` when you followed a precedent from another unit, `absence` when the value rests on something *not* being reported (weak: say so in `rebuttal.text`).
- **One leaf episode per decision.** The episode in a decision's `produced_by` must have no children and its `uses` must list only what that decision actually relied on. The per-paper episode is a parent: it produces nothing directly and lists no criteria in `uses`. `warrant` names only the criterion that licenses *this* value; cite choices in `backing` and procedures in `depends_on`. Why: `whitesnake affected` follows these edges, and a coarse episode makes a criterion change flag unrelated values. The CLI prints `W_COARSE_EPISODE` / `W_UNCITED_CRITERION` notes when this is violated.
- **Record failures as episodes** with `"outcome":"failure"` and what you tried in the body; they stop the next agent from repeating them.
- **Never set derived state** (`procedure.state`, `history`, `counters`) by hand; the CLI derives it from events.

## References

- `references/record-types.md`: every node type, its fields, and a complete example.
- `references/toulmin-fragility.md`: how claim, data, warrant, backing, qualifier and rebuttal map to the record, and when to use each fragility.
- `references/walton-checklist.md`: critical questions to run when there is no precedent, confidence is low, or a procedure and your own reading disagree.
- `references/cli-cheatsheet.md`: all commands with examples.
