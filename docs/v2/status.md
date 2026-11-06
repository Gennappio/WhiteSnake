**Implementation status for the 2.0 architecture**

Baseline: `bb85513`, reviewed 6 November 2026. Runtime package: `0.1.0`; configuration schema: `1`. These are distinct from the name of the intended 2.0 architecture.

| Capability | Current implementation | Remaining work |
|---|---|---|
| Node storage | Markdown/Git, SQLite index, validators, local code and artifacts | Global UID, explicit work contexts and complete component manifests |
| Agent execution | Claude Code, Codex and deterministic stub; synchronous delegation | Durable asynchronous tasks, cancellation/recovery and node-owned runner policy |
| Parent–child relationship | Local `stores` path map, `parent/<id>` worktrees | Per-project persistent sandboxes; explicit `use`/`research` |
| Procedure state | Replay shown/correction/transition events; cache validation and recomputation | Correct earliest-shown selection; broader replay/recovery verification |
| Reconciliation | Manual merge, cache-only conflict resolution, validation before commit | Validation/rollback after rebase; research-only publication; autonomous conflict workflow |
| Remote references | `{store, id, commit}` on selected edges; full commit in delegation evidence | UID/context addressing, resolution at the cited version, retention and offline closure |
| Feedback | Local outbox, `sync`, reduced mirrored turns, branch-local correction and shared-procedure question | Attribution of downstream errors, durable network delivery and explicit validation feedback |
| Authorization | Filesystem access and branch naming; actor strings for replay semantics | Child-owned grants, credentials, revocation and runtime enforcement |
| Discovery | Local lexical precedent search and local graph queries | Dynamic profiles, federated catalogs/search; optional backend evaluation |
| Handoff | Local export/check with file/artifact manifests | Materialized remote dependencies and a portable runtime backup |
| Transport | None between hosts; sync understands local directories | HTTP/JSON service, client, MCP stdio adapter |
| CI | Workflow for Ubuntu/macOS and Node 22.13/24 | Check actual hosted CI results; this review only ran locally |

**Verification performed.**

- `npm test`: 84 passed, 0 failed on macOS with Node `v23.10.0`.
- CLI contract gate: passed against `contract.json`.
- Additional focused reproductions: three defects confirmed; see the [review](implementation-review.md).
- The [local documentation example](examples/local-network.mjs) exercises the available parent–child path with a stub. Its outcome is documented in the review.
- No live Claude Code/Codex session, second-host transport, hosted CI run or real-corpus experiment was claimed by this review.

**Commands that do not exist yet.**

`serve`, `remote add`, `access grant`, `mcp`, a `--mode use|research` flag, `task reconcile` and automatic contribution promotion are proposed interfaces. Do not add future fields such as `uid`, `mode`, URL descriptors or access grants to the current strict `whitesnake.yaml` schema.

Today, register local paths by editing `stores:`. `config` prints configuration; it is not a configuration setter. `why` displays a remote boundary rather than fetching its target. `affected child:record` queries dependents in the current store; it does not propagate a correction over the network.

**Delivery order.**

First address the reproduced integrity defects and keep the existing local path tested. Run a real single-node pilot before expanding the execution runtime. Then implement identity/version retention and a thin read-only HTTP service, followed by grants, persistent per-project sandboxes, durable tasks and mode-aware publication. Build dynamic profiles and federation on top of those contracts. Additional harnesses and XERJ are conditional extensions, not prerequisites.

The inherited development plan's M5–M14 labels are planning references. They are not release-completion claims. [Milestones](../milestones.md) separates historical live tests from the newly tested local foundations.

