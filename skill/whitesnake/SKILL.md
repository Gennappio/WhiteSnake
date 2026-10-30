---
name: whitesnake
description: Work inside a WhiteSnake knowledge store (a directory containing whitesnake.yaml). Use whenever you annotate, decide, explain, correct or re-examine results in such a store, or when the user mentions whitesnake, provenance, precedents, decisions, evidence or procedures. Consult precedents, apply critical review when decisions need it, record evidence through the CLI, and register reusable procedures.
---

# WhiteSnake store

A WhiteSnake store turns research work into something another person or agent can inherit: every value you produce is a **decision** that cites **evidence** (verbatim excerpts with exact locators) and a **criterion** (the rule that licenses it), and records which **prompt** caused it. The store is plain files under `knowledge/`, validated and indexed by the `whitesnake` CLI. Read `whitesnake.yaml` for the mandate and the output fields.

The one rule that matters: **write to the store only through the CLI** (`whitesnake add`, `whitesnake set`, `whitesnake link`). A hook refuses the direct edits of `knowledge/**` it can recognise, and at the end of every turn the store compares the files under `knowledge/` with the CLI's write journal: anything written another way is reported as unvalidated and has to be redone through the CLI.

## Workflow for a task

1. **Orient.** `whitesnake frontier` shows open questions and provisional work. `whitesnake precedent "<key words>"` finds earlier decisions, criteria and procedures on the same problem. Reuse applicable, accepted results; do not re-derive them. `whitesnake why <id>` explains any existing result. Check the [critical review triggers](#critical-review) and, for large annotation tasks, apply the [generalization guidance](#generalization-for-large-annotation-tasks) before processing individual records.
2. **Open an episode** for the unit of work (one paper, one field, one check):
   `whitesnake add episode --json-in '{"title":"Annotate P02","resolution":"agent"}'` → prints `ep_…`. Nest sub-episodes with `"parent":"ep_…"`.
3. **Prefer existing procedures.** `whitesnake ls procedure` lists them with state and entrypoint. Check applicability and abstention conditions, reuse an applicable `trusted` procedure, and verify a `provisional` procedure's output before relying on it. Record the procedure in the episode's `uses`. Write new code only when none applies, save it under `procedures/<name>/`, and register it (see record-types).
   **Never edit the code of a procedure that produced a result.** Its hash is registered and the store becomes invalid if the file changes. To improve one, write a new procedure in its own directory and register it with `"supersedes": ["proc_old"]` and a `justification` (`kind` correctness | performance | scope | platform, the evidence ids that prove it, a sentence for the reader). Run `whitesnake procedure compare proc_old proc_new` to see whether it is never worse on any recorded case and better on one; the report is recorded. While the new one is provisional, run both on new inputs, list both in `uses`, show one value; if they disagree keep the trusted value, record the other output as rebuttal evidence and raise a question. Once the new one is trusted, `whitesnake procedure supersede proc_new` makes the replacement if the comparison and the declared thresholds allow it. `whitesnake procedure scorecard <id>` shows the measurements behind a procedure.
   **Run commands whose output is evidence through the store:** `whitesnake run "python3 procedures/table_counts/run.py corpus/P02.md Randomised" --episode ep_…` executes the command and records it as execution evidence in one step (command, exit code, platform, hashes of the input files, output). No need to write a script for a one-off command. When the same command recurs across episodes, `whitesnake procedure propose --from-evidence ev_… ev_…` distils the recorded executions into a procedure skeleton with regression cases; refine its applicability and let shown uses promote it.
4. **Capture evidence before deciding.** For each fact you rely on:
   `whitesnake add evidence --json-in '{"title":"P02 Table 1","kind":"excerpt","locator":{"artifact":"art_…","section":"Table 1"},"produced_by":"ep_…"}' --body "<verbatim excerpt>"`
   Sources are `artifact` nodes (`whitesnake ls artifact`). If a source file has no artifact yet, add one with its sha256 (`shasum -a 256 <file>`).
5. **Record the decision** in Toulmin form (claim, data, warrant, backing, qualifier, rebuttal):
   `whitesnake add decision --json-in '{"title":"P02 n_randomized_total","kind":"annotation","status":"active","claim":"84 participants were randomised (42 + 42)","qualifier":{"confidence":0.95,"scope":"P02"},"fragility":"mechanical","target":{"unit":"P02","field":"n_randomized_total","value":84},"data":["ev_…"],"warrant":["dec_<criterion>"],"produced_by":"ep_…"}'`
   `warrant` must name criterion decisions (`whitesnake ls decision --kind criterion`). `data` must be evidence ids. `caused_by` is filled automatically with the current turn.
6. **Close the episode:** `whitesnake set ep_… --json-in '{"outcome":"success","ended":"<ISO time>","produces":["dec_…","ev_…"]}'`.
7. **Verify and report.** `whitesnake validate` must print `ok`. Check the evidence for the requested result as well: store validity alone does not prove correctness, coverage or savings. Report unresolved cases and material limits. When you present results to the user, list the decision ids you created so they can be reviewed with `whitesnake why`.

## Critical review

Use [Walton-inspired critical questions](references/walton-checklist.md) when starting a large or costly task, interpreting a case without a precedent or with weak/conflicting evidence, extending a rule to a new population, encountering recurring errors or unexpected cost, or making a substantive completion claim. Read only the relevant sections. For routine reuse within a reviewed scope, apply the recorded conditions and existing checks.

Answer from the conversation, store and observable checks first. Resolve delegated implementation choices yourself. Ask the user only for an unresolved choice about meaning, goals, acceptable error, coverage or resources that changes the outcome; bring a concrete recommendation and its consequences. Reuse prior answers. Keep assumptions distinct from user decisions.

Record concise findings and evidence in existing decisions and episodes through the CLI. Review once per rule, batch or material change, then reuse that review within its scope. Reopen it when its inputs, criteria, procedure or supporting evidence change. This is an agent workflow; its effectiveness remains to be evaluated and it adds no automatic budget or approval enforcement.

## Generalization for large annotation tasks

**Experimental guidance: reliable generalization and cost control at scale remain a critical open design question.** These instructions guide the agent; they do not provide automatic budget enforcement or prove that a procedure generalizes.

- **Search for reusable rules early.** Profile repetitions, distinct values and recurring structures with code. Reuse structured metadata and identify the level at which each fact holds. Use representative cases and exceptions to develop parameterized procedures with explicit applicability and abstention conditions.
- **Validate beyond the examples used to build the rule.** Check separate cases, including different studies or datasets where relevant. Propagate a result across a group only when the evidence supports that scope. Shown uses alone do not establish accuracy on a large population.
- **Generalize execution as well as the calculation.** Build batch execution that selects applicable procedures, runs them and records provenance through the CLI without a model intervention for every record. Preserve the existing decision and episode requirements. Group unresolved cases before reasoning about them; use recurring exceptions to improve procedures.
- **Optimize total cost per correct result within the task's quality and coverage requirements.** Include rule development, validation, execution and recording costs. Sample automated outputs for review and avoid spending more on a generalization than its expected reuse justifies.
- **Respect the supplied budget and report measured limits.** Track model calls, tokens and costs, including retries and delegation, where metering is available; report unavailable measurements explicitly. Report automatic coverage, observed errors and unresolved cases. A budget instruction alone is not a hard spending limit; identify missing enforcement rather than claiming it exists.

## Rules

- **Consult before deciding.** Always run `precedent` before interpreting something. Check status, scope and relevant similarities before reusing a result. Apply an accepted criterion within its scope; record a conflict or changed condition instead of silently overriding it.
- **Separate what the source says, what you observed, what you decided.** Source text is `evidence` (verbatim). Your own measurement or script output is `evidence` of kind `observation` or `execution`. The interpretation is a `decision`.
- **Record at decision time with exact ids.** Never describe provenance in prose only.
- **Fill and flag within the agreed scope.** If a criterion is missing or ambiguous, create a `question` and, where useful, a bounded provisional decision with `"status":"proposed"`, a lower confidence and the question in `qualifier.scope`. Continue independent work. If proceeding would settle an unresolved user choice or exceed the agreed scope or budget, ask about that choice and defer only the dependent work. A provisional answer does not license propagation across a population.
- **Mark fragility honestly.** `mechanical` when a criterion applies directly, `interpretive` when you chose among readings, `analogical` when you followed a precedent from another unit, `absence` when the value rests on something *not* being reported (weak: say so in `rebuttal.text`).
- **One leaf episode per decision.** The episode in a decision's `produced_by` must have no children and its `uses` must list only what that decision actually relied on. The per-paper episode is a parent: it produces nothing directly and lists no criteria in `uses`. `warrant` names only the criterion that licenses *this* value; cite choices in `backing` and procedures in `depends_on`. Why: `whitesnake affected` follows these edges, and a coarse episode makes a criterion change flag unrelated values. The CLI prints `W_COARSE_EPISODE` / `W_UNCITED_CRITERION` notes when this is violated.
- **Cover gaps yourself, in the store that owns them.** When no procedure applies, solve the technical gap within the agreed criteria and resources and record it; an unresolved user choice follows the critical review rule above. Knowledge belongs to the store whose domain it is: if a question is really about another store, delegate it (`whitesnake delegate --child <store> --question ...`) so that store's agent records the answer there, and keep only the returned evidence here. If delegation is not possible, write into that store anyway with `whitesnake --store <its dir> ...` from your session: the CLI works on that store's branch for you, mirrors your turn there, and never copies its knowledge into yours.
- **Record failures as episodes** with `"outcome":"failure"` and what you tried in the body; they stop the next agent from repeating them.
- **Rewrite, never overwrite.** A rewritten procedure is a new record that names the old one and proves its reason; "it was slow" without two timings on the same inputs is not a reason. The old procedure leaves the ladder only through `procedure supersede`, which the CLI refuses while the new one is untrusted, regresses on a recorded case or misses a threshold criterion.
- **Never set derived state** (`procedure.state`, `history`, `counters`) by hand; the CLI derives it from events.

## References

- `references/record-types.md`: every node type, its fields, and a complete example.
- `references/toulmin-fragility.md`: how claim, data, warrant, backing, qualifier and rebuttal map to the record, and when to use each fragility.
- [Critical review](references/walton-checklist.md): trigger-specific questions, responsibility for decisions, evidence to record, and checks before extending rules or claiming completion.
- `references/cli-cheatsheet.md`: all commands with examples.
