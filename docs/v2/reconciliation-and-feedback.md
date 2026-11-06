**Reconciliation, feedback and procedure learning**

Reconciliation decides which work becomes shared knowledge. Feedback records what happened to a result after delivery. They interact, but neither is equivalent to receiving a response or merging text successfully.

**Current local behavior.**

A parent invokes a child on `parent/<parent-id>`. Its main remains unchanged. When a parent decision cites a child decision, `shown` and `correct` can queue feedback in `.whitesnake/outbox.jsonl`. `sync` applies it to the parent's child branch, mirrors a reduced turn and appends a delivery receipt in `.whitesnake/outbox-delivered.jsonl`.

The reduced turn contains ID, session, time and prompt hash rather than prompt text. Correction events still carry a reason and may carry a value: reduced turns do not mean that all parent content is absent from feedback.

Procedure state is derived from shown events, corrections and explicit transition decisions. On main, counting corrections belong to `human:researcher`; on a parent branch they belong to `human:researcher@<parent-id>`. These strings express replay context, not authenticated network identities. Shown events and explicit transitions have their own derivation rules; not every fact uses the correction-owner filter.

A correction on the parent branch can suspend its procedure there. If the procedure also exists on main, sync raises a question on the branch. `branch status` and SessionStart expose those questions to the child's researcher. This is a local review signal, not automatic canonical correction or scheduling of a research agent.

**Manual reconciliation today.** Run these commands from the child's main checkout:

```sh
whitesnake branch status
whitesnake validate
git status --short
whitesnake branch merge <parent-id>
whitesnake validate
```

Inspect the proposed work and unresolved questions before merging. Main must be clean. A merge uses `--no-ff --no-commit`, resolves conflicts confined to derived procedure caches, recomputes state from the combined events and validates the resulting store before committing. Other textual conflicts or validation errors abort the merge. The journal baseline is updated after success.

Reopening a branch rebases it on main and recomputes caches. **Validate the returned worktree before further work**: the reviewed implementation can report a successful rebase even when the combined records violate cell uniqueness. See [review finding R3](implementation-review.md). Avoid concurrent writers; there is no durable multi-writer coordination.

A successful merge establishes structural consistency, not scientific correctness or a right to publish. Context changes can also change which corrections count for procedure state. Review those consequences and the evidence explicitly.

**2.0 publication model.**

Use sandboxes stay separate from canonical state. A research contribution gets its own `research/<contribution-id>` workspace/branch. The grant is per parent; the reconciliation unit is the contribution. Existing per-parent branches need conservative classification before migration, and may contain multiple contributions.

After a completed authorized research contribution, the child schedules validation/reconciliation. It checks current authority, schema, references, code/artifact integrity, regression evidence, active-cell uniqueness and criterion/procedure transitions against the expected main revision. Publish atomically only if those checks still hold. A revoked grant or unresolved scientific conflict leaves the contribution unpublished.

Conflicts become explicit questions with resolvable references to both versions. The child agent records a justified choice and the appropriate canonical annotation or criterion; a choice record alone does not set an annotation cell. Data cites evidence, and the comparison must preserve the alternatives. Questions needing human judgment wait for that input; an open question alone is not an autonomous job scheduler.

**Delivery and evaluation must be separate.**

| Event | Meaning | Consequence |
|---|---|---|
| Acquired | The parent durably stored the delivered package | Delivery receipt; no claim of correctness |
| Shown | A particular result was actually presented to a specified reviewer | Observation of review exposure |
| Accepted/verified | A reviewer or check accepted it under recorded criteria | Evaluation evidence within that scope |
| Corrected | A result was found wrong, with reason and applicable evidence | Attribute the error before changing another component's status |
| Research published | A validated contribution entered canonical state | Update shared capabilities and notify dependent consumers |

The current implementation has shown/corrected events, not this complete feedback contract. Its shown-based trust threshold is not population-level validation. The Stop hook also infers shown IDs from the last assistant message without a dedicated v2 mode/reviewer distinction; live tests must verify headless versus human presentation.

**Correct attribution matters.** If the child returned 84 and the parent incorrectly doubled it to 170, correcting 170 to 168 does not make 84 wrong. Current feedback forwards corrections to cited child decisions too broadly; [R1](implementation-review.md) reproduces this. The v2 feedback contract needs task/result ID, component/version, adaptation, context, reviewer and reason. Permit feedback on one's own use task without granting research rights; let the child apply its own validation policy.

Replay must be independent of arrival order, including multiple shown events for one decision. Retries must not count as independent evidence. A summarized remote report may update observations, but a replayable regression case needs usable inputs or a minimal shared example. [R2](implementation-review.md) records the current ordering defect.

**Discover opportunities for research.**

The parent can propose an adapter it repeatedly needs. The child can retain minimal operational observations of base components, adaptation manifests, contexts and outcomes after discarding disposable caches. Queries can flag recurring unmet needs. The same base or matching hash alone does not establish generalizability; the research contribution still needs contracts, applicability and evidence.

Only accepted shared contributions update the public capability profile. A parent's private adapter remains discoverable within its project context. Corrections of shared capabilities must eventually reach consumers through versioned change events, including copied components and offline consumers; that distributed path is not implemented yet.

