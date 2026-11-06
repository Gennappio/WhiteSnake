**Implementation review — 6 November 2026**

Reviewed changes from `4e057be` to `bb85513`. Scope: event derivation, branch reconciliation, typed cross-store references, feedback delivery, CLI behavior and the documentation's executable path. This review does not certify a distributed 2.0 runtime.

**Verified results.**

| Check | Result |
|---|---|
| `npm test` | 84 passed, 0 failed; macOS, Node v23.10.0 |
| `node dist/src/cli.js gate --against contract.json` | Passed |
| `node docs/v2/examples/local-network.mjs` | Passed: delegation, shown/corrected delivery, retry deduplication, branch-local suspension, unchanged main, three valid views |
| Node-creation guide | Exact initialization flags and all seven inspection commands passed in a fresh temporary store |
| Documentation checks | Ten guides: relative links and fenced blocks checked; both example scripts pass syntax checks |
| Focused review cases | Three defects reproduced below |
| Live harness / hosted CI / second machine / real corpus | Not exercised in this review |

The existing suite is valuable: it covers merge validation, derived-cache conflict resolution and basic feedback delivery. Passing it does not cover the additional cases below. Runtime source was not modified as part of this documentation task.

**R1 — High priority: a parent-only error is attributed to the child's valid result.**

Relevant code: [correction forwarding](../../src/lifecycle/correct.ts), `correctDecision`, and [delivery](../../src/lifecycle/sync.ts), `syncOutbox`.

Reproduction: the child returns 84 for `P02/n_randomized_total`. The parent records `P02/twice_randomized = 170`, citing that child result, then corrects its own multiplication to 168. The correction is automatically queued for the child reference. Sync applies `correctDecision` to the child even though the cells differ; `sameCell` only controls whether a replacement value is forwarded.

Observed: the child's original value remains 84, but its decision becomes `needs_review` and its procedure becomes `suspended` on the parent's branch. The child's main remains unchanged. Expected: the parent's calculation is corrected without asserting that the child's 84 or its procedure is wrong.

Required change: represent a downstream correction as feedback needing causal attribution unless it explicitly identifies the child output/version as defective. Matching unit/field alone also cannot establish attribution across different contexts. Add a regression case where a valid remote result participates in an incorrect local computation.

**R2 — Medium priority: replay depends on the arrival order of multiple shown events.**

Relevant code: [event collection](../../src/lifecycle/derive.ts), `collectEvents`, which selects `n.shown_at[0]` before sorting procedure events.

Reproduction: use the toy procedure with promotion threshold 2 and its other existing shown result. Give one decision shown events at 10:00 and 12:00, with a counting correction at 11:00. Derive once with the shown array ordered chronologically, then with the same entries reversed.

| Array order | Shown counter | Derived state history |
|---|---|---|
| 10:00, 12:00 | 2 | provisional → trusted → suspended |
| 12:00, 10:00 | 1 | provisional → suspended |

Expected: the same events produce the same counters and history. Required change: choose the earliest effective shown timestamp, with deterministic tie-breaking and the existing fallback for legacy events, before procedure replay. The current sync-order test contains only one shown event and therefore misses this case.

**R3 — Medium priority: rebase reports success with an invalid combined store.**

Relevant code: [branch reopening](../../src/branch.ts), `openParentBranch`, after rebase and cache recomputation.

Reproduction: start with a valid child and parent branch. Add a new active annotation for `P02/n_randomized_total` on each side using different record IDs. Both sides validate separately and Git can combine the files without a textual conflict. Reopen the parent branch after main advances.

Observed: `branch open` exits 0; `validate` in the returned worktree exits 2 with `E_DUPLICATE_ACTIVE`. Expected: validate the combined candidate before declaring success, and preserve/recover the original branch if it cannot be reconciled. Manual `branch merge` already validates its result; the rebase path needs a corresponding guarantee.

**Other boundaries relevant to deployment.**

- Typed references preserve a commit in metadata, but sync currently targets the decision in the current parent worktree; it does not resolve/verify the cited historical version as a transport precondition.
- Outbox JSONL files are operational state excluded from export. There is no network queue durability, partial-tail recovery or multi-writer protocol.
- The Stop hook can mark decisions in a headless final answer as shown; a dedicated mode/reviewer contract and live behavioral checks are still needed.
- `why` stops at remote boundaries; export/check do not package or validate their remote closure.
- A worktree is not a security sandbox. Grant enforcement and the intended per-project modes do not exist yet.

These are limitations, not claims that the corresponding 2.0 features have been implemented incorrectly. The three numbered findings above were specifically reproduced.

**Reproduce the review cases.** After building:

```sh
node docs/v2/examples/review-cases.mjs
```

The script uses fresh toy directories and the stub, prints expected/observed behavior and exits nonzero while any reproduced defect remains. It does not change the source checkout or invoke a model. It is separate from the existing `npm test` suite so the current suite's 84-test result remains accurately described.

**Next verification.** Add the three cases as implementation regression tests while fixing them. Then repeat the documentation example, validate actual harness behavior for headless presentation and feedback, and run the real single-node pilot before extending remote execution.

