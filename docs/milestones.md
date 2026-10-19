# Milestones

Record of the outcomes of the plan's milestones (see `DESIGN.md`, section Milestones). A milestone closes only when its test passes.

## M1 — Store, CLI, skill, hooks: one agent on a toy case

**Closed on 2026-10-16.**

Deterministic tests (`npm test`): 29 passing. They cover schemas and identifiers, the validator with seven seeded corruptions (dangling edge, edge to the wrong type, duplicate ID, missing claim, inconsistent state cache, unknown type directory, tampered evidence body), the byte-identical rebuild of the index, the goldens of `why`, `affected`, `precedent`, `frontier` and `timeline`, idempotent ingestion of Claude Code and Codex logs, the hooks, `add`/`set`/`link` with rejection of wrong references, and the authority of declared citations in `affected`.

Live test (`npm run e2e:m1 -- --runs 3`): a real `claude -p` session annotates P02 and P03 in a clean copy of the toy store.

- First series: 2 runs out of 3. In the third, the agent had attached all the criteria to the papers' root episodes and produced the decisions directly from there, so the change of the ITT criterion reached 7 annotations instead of 3.
- Fix: in `affected`, the citations a decision declares (`warrant`, `backing`, `depends_on`) are authoritative over propagation through the episode; the validator emits the warnings `W_COARSE_EPISODE` and `W_UNCITED_CRITERION`; the skill prescribes one leaf episode per decision.
- Second series: 3 runs out of 3.

| Run | Duration | Turns | Cost | Complete chains | Correct values | Direct reads of knowledge/ | Denied writes | Hooks |
|---|---|---|---|---|---|---|---|---|
| 1 | 108 s | 15 | $0.34 | 6/6 | 6/6 | 0 | 0 | SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd |
| 2 | 168 s | 24 | $0.49 | 6/6 | 6/6 | 0 | 0 | as above, plus PreToolUse |
| 3 | 155 s | 22 | $0.44 | 6/6 | 6/6 | 0 | 0 | as above, plus PreToolUse |

In every run: `validate` without errors, a byte-identical index after rebuilding, `affected` after the criterion change equal to the expected set, first access to the store through the CLI.

Qualitative observations: the agent found on its own the deliberate discrepancy in P03 between the prose (147 analysed) and the table (148), applied the choice "table before prose" that was already in the store and cited it as backing, recorded the discordant sentence as evidence for the rebuttal, lowered the confidence to 0.7 with interpretive fragility, and reused the `table_counts` procedure for the four counts, recording its output as execution evidence.

Open for M2: Codex as the working agent, procedure states derived from events, `correct` and `shown`, the HTML review page, a real corpus.

## M2 — Procedure lifecycle, observability, both harnesses

**Live tests passed on both harnesses (2026-10-16); the test with human judgement on the real corpus remains.**

Deterministic tests: 34 passing at the time of the first live test (added: lifecycle with promotion to `trusted` after three shown results, `correct` with suspension of the procedure, replacement of the decision and propagation of `needs_review`, a Stop hook that records the decisions cited in the final message as shown, the review page, a guard on shell writes into `knowledge/`, the Codex rollout parser).

Three-session live test (`npm run e2e:m2`): **passed with Claude Code and with Codex**. Claude Code:

| Phase | Duration | Outcome |
|---|---|---|
| A. Annotation of P02 and P03 | 135 s | valid store, 6 complete chains; `proc_tablecount01` promoted to `trusted` without human intervention, with 5 shown uses recorded by the Stop hook |
| B. The researcher changes the criterion for the analysed population | 45 s | the agent used `whitesnake correct dec_crit0analyz1`; the three `n_analyzed_total` annotations (P01, P02, P03) moved to `needs_review`; the six annotations for randomised participants and outcomes stayed `active` with the same values; a new criterion was created that supersedes the old one |
| C. P04 arrives | 97 s | 3 complete chains and 3 correct values; episodes that reuse the trusted procedure; number of procedures unchanged; share of episodes resolved without an agent 0.50, against 0.375 in phase A |

Codex (`--harness codex --model gpt-5.6-sol`):

| Phase | Duration | Outcome |
|---|---|---|
| A | 141 s | valid store, 6 complete chains, procedure promoted to `trusted` with 5 shown uses; share without an agent 0.50 |
| B | 77 s | `whitesnake correct dec_crit0analyz1` invoked; the three `n_analyzed_total` annotations in `needs_review`; the other six intact; a new criterion that supersedes the old one |
| C | 96 s | 3 complete chains and 3 correct values; procedure reused; procedures 1 → 1; share without an agent 0.50 |

Codex as the working agent: the installed CLI (0.150.1) rejects the configured model `gpt-6-astra`; with `--model gpt-5.6-sol` the project hooks fire (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) and the M1 task (`npm run e2e:m1 -- --harness codex --model gpt-5.6-sol --runs 3`) passed **3 runs out of 3**: valid store, 6 complete chains and 6 correct values per run, exact `affected`, first access to the store through the CLI, zero direct reads, zero denied writes. Durations of 143, 243 and 131 seconds. Codex runs each step as a JavaScript program with several shell commands inside; the hooks still receive one event per single command.

## M3 — Simulated delegation, branching, handoff

**Closed on 2026-10-16 on the toy store: the deterministic parts and the live handoff test passed in full on the repeat run (the first execution failed only on delegation, because of the output schema; see below). The test on the real corpus awaits the data.**

Deterministic tests: 44 passing, including for M3: `export` with a manifest and `check` (an integrity violation detected at a one-byte difference, export with and without history, rejection of a store with uncommitted changes), per-parent branches (worktree, rebase on open, additive merge, a conflict on a decision rejected with exit code 4 and main intact, a conflicting rebase rejected with exit code 3), `delegate` with a stub runner (the child's work on the parent's branch; execution evidence and an episode with a remote child in the parent), `ask` with a stub, `gate` with a snapshot of the contract (44 commands).

Handoff test (`npm run e2e:m3`; Claude Code produces → Codex inherits in a clean directory, model `gpt-5.6-sol`). Final execution, **passed on every point**:

| Step | Outcome |
|---|---|
| Claude Code annotates P02 and P03 in the source store | valid store, 119 s |
| `whitesnake export` → a clean copy with a manifest; `whitesnake check` | ok: 52 records, 0 discrepancies, history included |
| Codex explains three annotations through `whitesnake ask` | **3/3** in both executions: every answer cites the decision, at least one piece of evidence and the criterion; confidence 0.99–1 |
| Codex records the criterion change (97 s) | `whitesnake correct dec_crit0analyz1` invoked; the three `n_analyzed_total` annotations in `needs_review`; the other six intact; a new criterion that supersedes the old one |
| Codex annotates P04 in the inherited copy (141 s) | 3 complete chains and 3 correct values; trusted procedure reused; it applies the new rule, noting that P04 does not report the per-protocol population |
| Delegation from a parent store to the inherited child | failed on the first attempt: the output schema had an optional property, and Codex's strict mode requires every property to be required; fixed (the field is now required and nullable). In the final execution: status `completed`, an answer citing the child's decision, two pieces of evidence and the criterion; in the parent, an episode with a remote child, execution evidence and an artifact; valid store |
| Questions addressed to the researcher | 0 in both executions; the full answers of the final execution are in `docs/handoff-answers-2026-10-16.md` for human judgement (correctness of the explanations, avoidable questions) |

Note on detection: in Codex rollouts the commands are nested inside JavaScript programs; the hook log (`.whitesnake/hooks.log`) is the authoritative source of the executed commands and is now used by the tests together with the transcript.

## M4 — Compaction, collapse, sublation

**Implemented and tested live on 2026-10-16 on the toy store; the test on the real store awaits the corpus.**

Deterministic tests (3 new, suite at 44 passing): `gc` leaves untouched a store in which everything is live, compacts a cold, failed subtree into a `template` node with negative examples, locators, the list of replaced ids and the source commit, leaves live provenance byte-identical, is idempotent on a second application and reversible from git history; `collapse` refuses a subtree that still needs the agent and composes a step procedure from two episodes resolved with code; `recheck` retires a procedure that the model reproduces and keeps the one it does not reproduce.

Live test (`npm run e2e:m4`): **passed with Claude Code and with Codex (`--harness codex --model gpt-5.6-sol`)**, with the same outcome. The model alone reproduces the regression case of the `table_counts` procedure (sum 120 on P01), and the procedure is retired by sublation; it cannot produce the sha256 of a file (null answer), and that procedure stays provisional; `why` on P01 still resolves to the retired procedure; final states `provisional=1, retired=1`; valid store.
