**Connect and exercise a local network**

Available today: parent and child stores in directories reachable by the same process. There is no IP/HTTP server in this revision. A path that happens to be on a mounted filesystem does not add authentication or durable distributed execution.

**Run the complete example.** From a built checkout:

```sh
node docs/v2/examples/local-network.mjs
```

The script creates a new directory under the system temporary directory. To preserve the demonstration at a location of your choice, pass a new path:

```sh
node docs/v2/examples/local-network.mjs /absolute/path/to/new-demo
```

Existing paths are rejected. The script uses a deterministic stub, configures Git identity only for its child processes and does not call Claude Code or Codex. It prints the parent, child, worktree, decision IDs and a feedback question, and writes `demo-result.json`.

It demonstrates delegation of the toy P02 count, a shown event, a synthetic correction of that same cell, idempotent sync, branch-local suspension, an unchanged child main and validation of all three views. The synthetic correction exercises transport semantics; it is not a scientific assertion about the toy paper. It deliberately leaves the branch unmerged.

**Register your own stores.** Initialize each store as described in [create a node](create-a-node.md). In the parent's `whitesnake.yaml`, replace the empty `stores` map while preserving its other settings:

```yaml
stores:
  simulation: /absolute/path/to/simulation-node
  knowledge: /absolute/path/to/knowledge-node
```

Each value is currently a local path string. An absolute path avoids ambiguity; relative paths are resolved against the parent directory. Keep store IDs unique across the connected stores. The current ID/alias scheme is not a global UID registry, and this configuration grants no network permissions.

A child can have its own `stores:` map for grandchildren. Each delegating agent must make the appropriate calls; there is no persistent recursive task scheduler or enforced global budget/depth policy.

**Delegate a real task.** Run from the parent:

```sh
whitesnake delegate --child simulation \
  --question "Run the validated simulation for the supplied experiment and report assumptions and results." \
  --why "This result is needed by the parent project." \
  --harness claude
```

Use `--harness codex` when intended. In this implementation, `delegate` takes its harness from the command options and defaults to Claude; it does not automatically select the child's configured harness. Input IDs/paths can be passed with `--inputs`, but files are not automatically uploaded to another machine.

The call is synchronous. The child executes in `.whitesnake/worktrees/<parent-id>` on `parent/<parent-id>` and keeps its work there. The parent receives a delegation artifact, execution evidence with typed citations and an episode. This is the current branch model, not enforcement of either v2 mode.

The current runner uses permissive harness flags; a worktree does not enforce resource or filesystem isolation. Use the local prototype in an environment appropriate to that behavior. [Source runner](../../src/agent/runner.ts)

**Inspect and return feedback.**

Run `why <parent-record-id>` in the parent and `get <child-record-id>` inside the returned child worktree. Remote citations are boundaries in `why`; inspecting the child is a separate local operation.

When the parent records a decision based on the answer, cite the actual child record and the full commit from the returned evidence:

```sh
whitesnake link <parent-decision-id> depends_on <child-store-id>:<child-decision-id>@<full-commit>
whitesnake shown <parent-decision-id>
whitesnake sync
```

`shown` requires a recorded turn, normally supplied by the active harness hooks. The demonstration script creates a synthetic turn explicitly. A returned headless answer is not, by itself, evidence that a human saw or accepted it.

`sync` returns delivered and pending events. A missing local child or a conflict leaves a pending reason; a successful process exit does not imply every event was delivered. Stop/SessionEnd/PreCompact hooks also attempt delivery.

Read [the feedback caveat](implementation-review.md) before correcting a derived parent result: current forwarding may attribute a parent-only calculation error to a valid child result.

**Review changes at the child.** Run inside the child main checkout:

```sh
whitesnake branch status
whitesnake validate
```

Open questions raised by remote corrections are listed on the parent branch. Review them in that worktree. Publication is a separate manual operation described in [reconciliation](reconciliation-and-feedback.md). No `--mode`, permission grant or automatic publication should be inferred from these commands.

