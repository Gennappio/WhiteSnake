**Reuse, discovery, provenance and handoff**

The network should allow an agent to find existing code and understand when it is applicable. It should also preserve enough evidence for another person or agent to inherit the work without the original conversation.

**Current tools.**

Inside a store, use `precedent` for lexical discovery, `frontier` for unresolved work, `why` for explanation, `affected` for dependencies and `procedure scorecard` for observed behavior. Remote references are typed but displayed as boundaries. `affected <store>:<id>` returns dependents here; it does not fetch or change another store.

Decisions can reference remote records through `data`, `backing` and `depends_on`; evidence can use `cites`. `warrant` remains local because it expresses the criterion applied by this store. Delegation evidence pins child decisions/evidence to a full commit. Other remote references may have a null commit, and the local validator does not check their remote existence.

**Components in the target design.**

A reusable component needs a manifest covering all code files, entrypoints, imports, configuration, weights, environment/dependencies, input/output contracts, applicability, examples, tests and provenance. Today's `code_hash` covers the entrypoint only. Hashing a wrapper does not establish the integrity of its helpers or weights.

Choose a functional module size. Preprocessing, a solver and result analysis can be separate components; tightly coupled code can remain together. The agent can invoke a component at its node, retrieve it for explicit local reuse, or derive an adaptation. Delegating a simulation normally executes it in the child; downloading code is a separate reuse operation.

A use adaptation runs in the project's child sandbox and is delivered as a versioned snapshot to the parent. A shared improvement goes through authorized research. Preserve `derived_from` separately from a justified `supersedes`; validity does not automatically transfer to a new environment or composition.

**Dynamic discovery.**

A node profile summarizes published capabilities, important findings, limits and supporting evidence. It changes after meaningful research/publication events and relevant invalidations. The full catalog remains searchable even when a component is not advertised in the summary. Private use work does not silently broaden the child's public mandate.

Begin with the existing lexical approach and explicit metadata. Consider XERJ or another backend only after representative queries expose a limitation and a comparison demonstrates benefit. The search backend is not the node's authority, scheduler or protocol.

**Export today.** From the store directory, to a new destination:

```sh
whitesnake validate
git status --short
whitesnake export /absolute/path/to/new-export
```

A Git-backed source must be clean. `export` creates a copy with a manifest, copies artifacts that may be outside Git tracking, excludes `.whitesnake/` and generates derived views. `--no-history` deliberately excludes prior history. It does not package unresolved remote references or the runtime outbox/worktrees.

In the exported directory:

```sh
whitesnake check --no-run
whitesnake why <local-decision-id>
```

`check` without `--no-run` also executes code regression cases and may record failures/suspensions. Successful local checking does not prove remote dependency availability. Existing skill/harness links and execution environments also need verification on the receiving machine.

**Offline handoff requirement.**

The complete v2 export must materialize the dependency closure needed to explain and, where promised, rerun the selected work: exact remote records, code and artifacts with origin UID, revision and hashes. The resolver must use those imported snapshots offline without changing their identity or merging them into unrelated local knowledge.

Support an explicit partial export with exclusions and reasons, but do not report it as a complete offline handoff. If a required source is already offline and was never captured, the export must report the missing content. Test by shutting down the child before explaining a parent's result in a clean environment.

**Retention and backup.**

Full hashes identify commits but do not keep them alive. The proposed retention mechanism pins cited commits under refs such as `refs/whitesnake/cited/<sha>` before a durable citation is delivered; published main history is not rewritten. Retain non-Git blobs separately by hash. Include these refs and blob inventories in backup/restore. Neither commit pinning nor remote dependency materialization is implemented yet.

An operational backup must also preserve event/outbox logs, delivery receipts, active sandbox state, branch refs and future grant/revocation state. A scientific export currently removes `.whitesnake/`, so it cannot recover pending feedback or ongoing work. Stop writers and verify a restore of the complete layout; a relocated worktree requires its Git metadata and paths to be reconciled. There is no supported one-command portable runtime restore at this revision.

Keep ownership, execution and preservation distinct: the project owns the use work, the child runs and maintains its operational sandbox, and the parent retains the snapshots and evidence needed to inherit the project.

