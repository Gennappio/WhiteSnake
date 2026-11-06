**Remote network and authorization — 2.0 design**

Status: design, not executable deployment instructions for `bb85513`. No HTTP server, MCP adapter, access-grant store or asynchronous remote task API exists in the current checkout.

**Service boundary.**

One installation can eventually host several stores. Each has a stable node UID, advertised endpoint, published catalog, grant registry and sandbox contexts. Start with one store over HTTP/JSON. A local MCP stdio adapter can expose the same operations to agent clients. The WhiteSnake task semantics remain independent of either transport.

An IP address or DNS name locates an endpoint; it does not identify the node or authorize a caller. A move preserves UID; an independent fork gets a new UID and cites its origin. Use the same application contract locally and remotely, with encrypted transport between hosts.

**Two registrations.**

| On the parent | On the child |
|---|---|
| Child UID, endpoint, local alias and credential reference | Parent identity, credential verifier and actual permissions |
| Describes how to reach the child | Determines what the caller may do |
| Observed permissions can be cached for display | Current grant is authoritative for every operation |

The child administrator/researcher grants `read`, `use` and/or `research`. A separate random credential identifies each parent's grant; the child stores its verifier, not a public secret. Record grant ID/revision, target node, issuer, time, state and optional expiration. The agent executing research cannot alter access grants merely because it may contribute code.

The proposed command name `access grant --parent ... --allow read,use,research` documents intent only; it is absent from the CLI. Current path registration is not a substitute for this mechanism.

**Check permission at execution boundaries.**

Authenticate the caller rather than trusting a supplied UID. Check the requested mode on receipt, before starting/resuming a queued job and before publication. Preserve the checked grant revision in the audit record, but use the current grant for new authorization decisions. Coordinate revocation with publication so an earlier check cannot authorize a later forbidden commit.

Research permission does not force research mode. A caller with all permissions may submit use. Reject a forbidden mode explicitly rather than silently changing it. Revocation/expiration stops new work under the removed permission and requests cooperative cancellation of relevant running jobs; preserve their partial work and provenance. It does not retroactively invalidate scientific results.

If A may research B, A gains no automatic rights on C. B needs its own grant from C, and the original task context must permit research there. A use chain cannot exploit an intermediary's unrelated research privileges. Do not forward A's bearer credential to C.

**Remote task and sandbox contract.**

The caller creates a stable task ID for a particular invocation. Keep that ID across retries and fingerprint the complete semantic request separately. Same caller/ID and same request returns the original task; a changed request conflicts; a new ID permits an intentional rerun.

Record owner/context, immediate caller, ancestors, requested mode, pinned base/sandbox revisions, inputs, output contract, criteria, resource limits and reuse policy. The child owns execution and selects its configured harness in the target design. Use a durable file event log and reconstructible task index. Separate technical status, scientific outcome, receipt and research-publication status.

Persist the request before acknowledging it, validate results before delivery and retain undelivered artifacts. On restart reconcile event log, process/attempt, workspace, result and receipt before rerunning. A process exit, an acknowledgment and successful research publication are different events. Define bounded retries, cancellation, budget reservations and explicit unknown outcomes for non-idempotent external effects.

Use sandboxes are persistent per parent/project. Run-specific workspaces/checkpoints prevent one task from overwriting another. Closing a sandbox requires an explicit lifecycle decision after pending tasks/deliveries and retained citations are accounted for; acknowledgment alone does not close it.

**Read/discovery contract.**

Expose identity, catalog, records, exact explanations, artifacts by hash, search and change cursors. Every result carries origin and revision. Publish canonical content, not host credentials, other parents' sandboxes or operational logs. Use profiles to find a node and full catalogs to find internal reusable components.

A0 should demonstrate a record, its explanation and an artifact at two revisions from a second host, including denied access. Subsequent gates add mode enforcement, persistent execution, recovery, research-only reconciliation and consumer correction propagation. The full list of available versus planned capabilities is in [status](status.md).

