**Create and develop a WhiteSnake node**

This guide uses commands available at `bb85513`. It creates a local store. Hosting it as an authenticated network node is a later step described in [network and permissions](network-and-permissions.md).

**Prepare the checkout.**

Use Node 22.13 or newer, Git and Python 3 for the bundled Python procedure/examples. A real agent session also needs an installed and configured supported harness. Git needs an author name/email because initialization, hooks and reconciliation create commits.

From the repository root:

```sh
npm ci
npm run build
npm test
export WHITESNAKE_REPO="$PWD"
export PATH="$WHITESNAKE_REPO/bin:$PATH"
whitesnake --help
```

Keep the checkout available: initialization links the shared skill to its current location. Moving the checkout or copying a store to another machine requires checking those links and the installed harness configuration.

**Initialize a project.** Replace the example absolute directory with a persistent location you own:

```sh
whitesnake init /absolute/path/to/simulation-node \
  --id simulation-node \
  --name "Simulation node" \
  --mandate "Develop, validate and run simulations; record assumptions, units and limits." \
  --harness claude \
  --unit experiment \
  --field peak:number
```

The field option uses `name:type[:description]`, with one token per field. Omit `--field` until the output contract is known. For Codex choose `--harness codex` at initialization. Initialization configures the store and hook files; it does not itself verify a live harness session.

An initialized store contains:

| Path | Purpose |
|---|---|
| `whitesnake.yaml` | Local ID, mandate, harness, output fields and child paths |
| `knowledge/` | Questions, decisions, evidence, procedures, episodes, sessions and turns |
| `procedures/` | Executable code and regression cases |
| `corpus/`, `artifacts/` | Sources, models, inputs and generated material |
| `output/` | Derived outputs |
| `.whitesnake/` | Index, runtime logs, outbox and local child worktrees; not ordinary versioned knowledge |
| `.git/` | Version history |

Use Git-backed stores when delegating. The current cross-store fallback without Git does not provide branch isolation.

**Teach the node through work.** Start the chosen harness in the store directory, with the generated hooks and shared skill enabled. A useful first request is:

> Establish the input/output contract for this simulation. Record assumptions, units and acceptance criteria. Search existing procedures, implement the missing parts, run a small reproducible case and record evidence. Keep unresolved scientific choices explicit.

Initialization does not create a simulator, download weights or establish scientific validity. The researcher and agent build those capabilities through the project's work.

The agent records decisions through the CLI, executes reproducible steps with `run`, registers reusable procedures and records corrections when a result is wrong. Code that produced results must be preserved; an adaptation becomes a new procedure with provenance and tests.

**Inspect the node.** Run inside the store:

```sh
whitesnake config
whitesnake frontier
whitesnake precedent "simulation boundary conditions"
whitesnake validate
whitesnake check --no-run
whitesnake kpi
whitesnake render
```

`check --no-run` performs the non-execution checks. `check` also runs supported code regression cases and can record a suspension when they fail; it is not a read-only command. A procedure's trusted state means it passed the project's event-based rules, not universal scientific validity.

The direct harness workflow is the currently available research workflow. An explicit `research` permission/mode is not implemented yet. To compose nodes, continue with [the local-network guide](local-network.md).

