# AutoSoft

AutoSoft turns research and automation work done with a coding agent into something another person or agent can inherit: a **knowledge store** where every produced value is a decision that cites verbatim evidence with an exact locator, the criterion that licenses it, the episode that produced it and the prompt that caused it. Procedures the agent writes along the way are registered, reused, and promoted or demoted from use. The store is plain Markdown files in git, validated and indexed by the `autosoft` CLI, and driven through Claude Code or Codex with a shared skill and a shared set of hooks.

The design decisions and their rationale are in [DESIGN.md](DESIGN.md) (Italian). The original design conversation is in `docs/origine/`.

## Layout

- `src/` TypeScript sources of the CLI (`autosoft`): record schemas, store validator, SQLite index, provenance queries, harness log ingest, hook runner.
- `skill/autosoft/` the skill that teaches an agent how to work inside a store (same file for Claude Code and Codex).
- `hooks/templates/` hook settings installed into a store by `autosoft init`.
- `examples/toy-store/` a small, valid store generated from `examples/toy-corpus/` by `npm run make-toy`; fixture for tests and for the live acceptance test. P01 is annotated as a precedent; P02 is straightforward; P03 reports both ITT and per-protocol counts and contains a deliberate disagreement between prose and table, so an agent must apply the store's criteria and record the conflict.
- `test/` deterministic tests (`node:test`) with goldens in `test/fixtures/toy-golden/`.
- `bin/autosoft` launcher so the CLI works from `PATH` without a global install.

A **store** is a separate directory (and git repository) created with `autosoft init <dir> --id <id> ...`. It contains `autosoft.yaml` (mandate, output fields), `knowledge/<type>/<id>.md` records, `corpus/`, `procedures/`, `artifacts/`, `output/` (derived), and `.autosoft/` (index, hook log, current turn; not versioned).

## Requirements

Node 22.13 or newer (tested on 23.10), git. For the live test: the `claude` CLI. No native dependencies.

## Build and test

```
npm install
npm test            # build + deterministic tests
npm run make-toy    # regenerate examples/toy-store
```

Add `bin/` to your `PATH` (or `npm link`) to call `autosoft` directly.

## Live acceptance test (M1)

```
npm run e2e:m1 -- --smoke          # checks that hooks fire in a headless Claude Code session
npm run e2e:m1 -- --runs 3         # a real session annotates P02 and P03 in a fresh copy of the toy store
```

A run passes when the store validates, every annotated cell has a complete provenance chain (evidence with resolvable locator, criterion as warrant, prompt of this session as `caused_by`), the index rebuild is byte-identical, changing the ITT criterion marks exactly the `n_analyzed_total` annotations as affected, every hook fired without errors, and the agent's first access to the store went through the CLI rather than reading `knowledge/` files.

## Codex

The same store works with Codex: `autosoft init` writes `.codex/hooks.json` (same events as the Claude Code hooks) and links the skill into `.agents/skills/`. Codex runs project hooks only after you trust them with `/hooks`, or for one invocation with `codex exec --dangerously-bypass-hook-trust`, which the live test uses. If your `~/.codex/config.toml` selects a model newer than the installed CLI accepts, pass a supported one: `npm run e2e:m1 -- --harness codex --model gpt-5.6-sol`.

## Lifecycle of procedures and decisions

States are never edited by hand; the CLI derives them from recorded events and the validator cross-checks the cached state against the history.

- `autosoft episode open|close` brackets a unit of work; a decision's `produced_by` must be a leaf episode listing in `uses` only what it applied.
- `autosoft shown <ids>` records that decisions were presented to the researcher (the Stop hook also scans the agent's final message for decision ids). The first time a decision is shown, each procedure its episode used earns a shown use; at `promotion.shown_uses_to_trust` uses without a correction (default 3) a provisional procedure becomes trusted.
- `autosoft correct <id> --reason ... [--value v]` records a researcher correction: the decision is marked `needs_review` (or superseded by a new one when a value is given), the episode becomes `corrected`, the procedures it used are suspended, and everything that relied on the decision is marked `needs_review`.
- `autosoft resolve --unit U --field F` applies the resolution ladder: an accepted decision, a trusted procedure, or agent work.
- `autosoft kpi` and `autosoft render` (writes `review.html`) show how the store is doing: episodes resolved without an agent, decisions by status and whether they were shown, procedure transitions per session, items to review, the timeline by prompt, and recording warnings.

## CLI

`autosoft --help` lists every command. The ones an agent uses most: `precedent`, `frontier`, `why`, `affected`, `add`, `set`, `link`, `shown`, `validate`. See `skill/autosoft/references/cli-cheatsheet.md`.

## License

MIT.
