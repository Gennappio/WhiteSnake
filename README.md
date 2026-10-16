# WhiteSnake

WhiteSnake turns research and automation work done with a coding agent into something another person or agent can inherit: a **knowledge store** where every produced value is a decision that cites verbatim evidence with an exact locator, the criterion that licenses it, the episode that produced it and the prompt that caused it. Procedures the agent writes along the way are registered, reused, and promoted or demoted from use. The store is plain Markdown files in git, validated and indexed by the `whitesnake` CLI, and driven through Claude Code or Codex with a shared skill and a shared set of hooks.

The design decisions and their rationale are in [DESIGN.md](DESIGN.md) (Italian). The original design conversation is in `docs/origine/`.

## Layout

- `src/` TypeScript sources of the CLI (`whitesnake`): record schemas, store validator, SQLite index, provenance queries, harness log ingest, hook runner.
- `skill/whitesnake/` the skill that teaches an agent how to work inside a store (same file for Claude Code and Codex).
- `hooks/templates/` hook settings installed into a store by `whitesnake init`.
- `examples/toy-store/` a small, valid store generated from `examples/toy-corpus/` by `npm run make-toy`; fixture for tests and for the live acceptance test. P01 is annotated as a precedent; P02 is straightforward; P03 reports both ITT and per-protocol counts and contains a deliberate disagreement between prose and table, so an agent must apply the store's criteria and record the conflict.
- `test/` deterministic tests (`node:test`) with goldens in `test/fixtures/toy-golden/`.
- `bin/whitesnake` launcher so the CLI works from `PATH` without a global install.

A **store** is a separate directory (and git repository) created with `whitesnake init <dir> --id <id> ...`. It contains `whitesnake.yaml` (mandate, output fields), `knowledge/<type>/<id>.md` records, `corpus/`, `procedures/`, `artifacts/`, `output/` (derived), and `.whitesnake/` (index, hook log, current turn; not versioned).

## Requirements

Node 22.13 or newer (tested on 23.10), git. For the live test: the `claude` CLI. No native dependencies.

## Build and test

```
npm install
npm test            # build + deterministic tests
npm run make-toy    # regenerate examples/toy-store
```

Add `bin/` to your `PATH` (or `npm link`) to call `whitesnake` directly.

## Live acceptance test (M1)

```
npm run e2e:m1 -- --smoke          # checks that hooks fire in a headless Claude Code session
npm run e2e:m1 -- --runs 3         # a real session annotates P02 and P03 in a fresh copy of the toy store
```

A run passes when the store validates, every annotated cell has a complete provenance chain (evidence with resolvable locator, criterion as warrant, prompt of this session as `caused_by`), the index rebuild is byte-identical, changing the ITT criterion marks exactly the `n_analyzed_total` annotations as affected, every hook fired without errors, and the agent's first access to the store went through the CLI rather than reading `knowledge/` files.

## Codex

The same store works with Codex: `whitesnake init` writes `.codex/hooks.json` (same events as the Claude Code hooks) and links the skill into `.agents/skills/`. Codex runs project hooks only after you trust them with `/hooks`, or for one invocation with `codex exec --dangerously-bypass-hook-trust`, which the live test uses. If your `~/.codex/config.toml` selects a model newer than the installed CLI accepts, pass a supported one: `npm run e2e:m1 -- --harness codex --model gpt-5.6-sol`.

## Lifecycle of procedures and decisions

States are never edited by hand; the CLI derives them from recorded events and the validator cross-checks the cached state against the history.

- `whitesnake episode open|close` brackets a unit of work; a decision's `produced_by` must be a leaf episode listing in `uses` only what it applied.
- `whitesnake shown <ids>` records that decisions were presented to the researcher (the Stop hook also scans the agent's final message for decision ids). The first time a decision is shown, each procedure its episode used earns a shown use; at `promotion.shown_uses_to_trust` uses without a correction (default 3) a provisional procedure becomes trusted.
- `whitesnake correct <id> --reason ... [--value v]` records a researcher correction: the decision is marked `needs_review` (or superseded by a new one when a value is given), the episode becomes `corrected`, the procedures it used are suspended, and everything that relied on the decision is marked `needs_review`.
- `whitesnake resolve --unit U --field F` applies the resolution ladder: an accepted decision, a trusted procedure, or agent work.
- `whitesnake kpi` and `whitesnake render` (writes `review.html`) show how the store is doing: episodes resolved without an agent, decisions by status and whether they were shown, procedure transitions per session, items to review, the timeline by prompt, and recording warnings.

## Commands versus code

An agent that solves a step with a terminal command is not forced to write software. `whitesnake run "<command>" --episode <id>` executes the command and records it as execution evidence (command, exit code, platform, hashes of the input files, output). When the same command recurs across episodes, `whitesnake procedure propose --from-evidence <ids>` distils the recorded executions into a procedure skeleton with one regression case per execution; shown uses then promote it like any procedure. On another machine, `whitesnake check` (also run automatically at the first open of an imported store) re-runs the regression cases of code procedures and suspends those that no longer reproduce, with the platform in the reason: the agent falls back to doing the step itself and may supersede them with an adapted version. Past outputs always stand.

## Handoff, branches and delegation

- `whitesnake export <dir> [--no-history]` clones the store for handoff with a `manifest.json` (integrity hashes of every record, artifacts present or excluded, whether git history is included), the rendered review page and the derived output. `whitesnake check` on the imported copy verifies the manifest, the artifacts, the records and rebuilds the index.
- `whitesnake branch open --parent <id>` gives a parent store its own branch `parent/<id>` and worktree in a child store, rebased on main; `branch status` and `branch merge <id>` reconcile explicitly. Evidence merges by itself; a conflict on decisions, criteria or procedures aborts and is listed, leaving main untouched.
- `whitesnake delegate --child <dir|id> --question "..." [--why ...] [--harness claude|codex]` runs the child store's agent on this store's branch with a structured task and records the answer here as execution evidence plus an episode whose child is a remote reference. `whitesnake ask "<question>"` answers a question about the store from CLI queries, citing record ids.
- `whitesnake gate` compares the CLI surface with the committed `contract.json`: additive changes pass, removals and renames fail. Run `gate --snapshot` when a breaking change is intended and versioned.

## Compaction, collapse and sublation

- `whitesnake gc [--apply] [--cold-after N]` compacts closed, cold episode subtrees that nothing live depends on into `template` nodes (summary, locators, negative examples, the ids replaced and the commit that still holds the raw files) and removes them from the working tree. Live provenance never changes; git history keeps the raw records; a second apply is a no-op.
- `whitesnake collapse <episode>` turns a parent episode whose children were all resolved without an agent into one composed procedure (a step list reusing the children's procedures). The agent call moves one level up.
- `whitesnake procedure recheck <id> --harness claude|codex [--model M] [--retire]` is the sublation check: the model alone, without the procedure's code, must reproduce every regression case. When it does and `--retire` is given, the procedure is retired; its past outputs stand.

## CLI

`whitesnake --help` lists every command. The ones an agent uses most: `precedent`, `frontier`, `why`, `affected`, `add`, `set`, `link`, `shown`, `validate`. See `skill/whitesnake/references/cli-cheatsheet.md`.

## License

MIT.
