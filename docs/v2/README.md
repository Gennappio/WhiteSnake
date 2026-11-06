**WhiteSnake 2.0 — documentation for a network of research agents**

Reviewed on 6 November 2026 against source commit `bb85513`. Here, **2.0 names the network architecture**. The package currently reports `0.1.0`, with store schema version `1`; an HTTP network service and explicit `use`/`research` enforcement have not been released.

A researcher builds a node by working with its agent. The node retains code, decisions, criteria, evidence and validation history. A parent delegates a bounded task to a child, which executes it using its own environment. The same relationship repeats through descendants.

**Start here.**

| Goal | Guide | Availability |
|---|---|---|
| Create and develop a store | [Create a node](create-a-node.md) | Available locally |
| Connect stores and run a complete demonstration | [Local network](local-network.md) | Available on one filesystem |
| Understand execution and ownership | [Parent–child model](parent-child.md) | Current behavior and v2 design distinguished |
| Review feedback and publish shared work | [Reconciliation and feedback](reconciliation-and-feedback.md) | Local commands available; automated workflow planned |
| Connect nodes across machines | [Network and permissions](network-and-permissions.md) | Design; transport and access grants not implemented |
| Find, reuse and inherit work | [Reuse and handoff](reuse-and-handoff.md) | Local facilities available; federation/offline closure planned |
| Check readiness and outstanding work | [Status](status.md), [review](implementation-review.md) | Verified against this revision |

**The central decisions.**

1. A delegated simulation runs in the child, using its tools and resources.
2. In `use`, task-specific code lives in the child's persistent sandbox for the parent/project. The parent retains its scientific project memory and versioned copies or manifests of the work it acquires.
3. In `research`, an authorized caller contributes to the child's shared knowledge and code. Publication follows the child's validation and reconciliation rules.
4. A parent registers an endpoint to find a child. The child separately grants permissions to the parent. Registration is not authorization.
5. Feedback returns from the parent to the child. Receiving a result, showing it, accepting it and correcting it are distinct events.
6. Delegation forms a tree of task occurrences. Shared components and evidence form a graph across nodes.

The current implementation uses local directories and a persistent `parent/<id>` worktree per parent. It does not yet distinguish projects, modes or authorization. Those worktrees organize changes; they are not an operating-system security sandbox.

**Try the available foundation without a model.** From the repository root:

```sh
npm ci
npm test
node docs/v2/examples/local-network.mjs
```

The example creates disposable stores, delegates through the stub harness, returns shown/corrected feedback, checks that the child's main remains unchanged, and prints paths for inspection. It does not claim to test network transport, a real simulation or model behavior.

Read the [review](implementation-review.md) before relying on automated feedback or rebasing concurrent work. The existing 84 tests pass, but three additional cases reproduce defects.

