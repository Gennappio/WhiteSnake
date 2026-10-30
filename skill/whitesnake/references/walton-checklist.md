# Critical review inspired by Walton

Use critical questions to test the grounds of a decision and find conditions that would defeat it. The source questions below draw on Walton's argumentation schemes; the task, generalization and cost questions adapt that approach to WhiteSnake.

## Triggers and scope

| Trigger | Sections to use | Observable result |
|---|---|---|
| Starting a large or costly task | Task and method | Criteria and constraints recovered; material assumptions and verification approach recorded |
| No precedent, weak evidence or conflicting readings | Source and inference; disagreement where relevant | Supported interpretation, narrowed claim or explicit unresolved question |
| New rule, wider population or broad propagation | Generalization | Validation evidence, applicability and abstention conditions |
| Repeated failures, changed inputs or unexpected cost | Disagreement; task and method | Cause investigated and method retained, revised or restricted with evidence |
| Substantive completion or savings claim | Verification | Results compared with the actual requirements; remaining gaps stated |

Review the relevant decision or batch once. Reuse a recorded review while its scope, inputs, criteria and procedure remain applicable; reopen it on material changes or contrary evidence. An ordinary record within a reviewed scope needs its normal applicability checks, not another full discussion. Scale the review to the consequence of being wrong. Do not create a separate design document or request approval merely because a trigger fired.

## Who answers

First consult the conversation, `whitesnake config`, `precedent`, `get` and `why`. Use source inspection or a bounded experiment to settle factual uncertainty when possible.

- **User choices:** purpose, domain meaning, acceptable error, coverage and resources. Reuse choices already made. If a missing choice changes the result or authorized scope, ask one focused question with a concrete recommendation and consequences, in the user's vocabulary.
- **Method:** choose and test an approach within those constraints. Explain a trade-off to the user when it changes the outcome they requested.
- **Implementation:** settle delegated choices such as libraries, data structures and code organization yourself. If the user has explicitly reserved a technical choice, respect that boundary.

Label your own assumptions and choices accurately; do not record them as user agreement. An open `question` is a record of uncertainty, not automatically a request to the user. If user input is required, defer only the dependent work and continue independent work. A bounded provisional result may be useful, but must not silently become the policy for a large batch.

## Task and method

Use these before substantial work or when cost or repeated failures call the approach into question:

- What outcome is needed, and which existing criteria define correctness, coverage and acceptable abstention? What is still an assumption?
- What evidence will distinguish success from a plausible-looking output? Which checks can be performed independently of the implementation?
- Can structured data, a previous result or an applicable procedure resolve this? If new reasoning is needed, what reusable rule might it produce?
- Does the expected reuse justify development, validation, execution and provenance costs? What measured result would make us narrow or change the approach?
- What budget or other resource limit applies, what usage is measurable, and what actually enforces the limit? Mark missing measurements as unavailable; do not infer zero spending from a `code` episode.

## Source and inference

Select the questions matching the inference being made.

**Argument from sign** (the text shows X, therefore Y):

- Could the sign be produced by something other than Y, such as a different population, time point or typo?
- Is the sign reported for the whole unit or for a subgroup?

**Argument from precedent** (unit A was treated this way, so unit B is too):

- Is B relevantly similar to A on the features the criterion depends on?
- Is A's decision accepted and still active, or proposed, corrected or outside the present scope?

**Argument from the author's position to know** (the paper states it):

- Does the paper state the claim, or are you inferring it from a caption or figure?
- Do two places disagree? Cite both and identify the criterion that supports the choice.

**Argument from absence** (not reported, therefore not done):

- Would the source have reported it if it were true?
- Could a supplement or protocol contain the missing information?

## Generalization

Use these before a new rule is applied broadly or an existing one is extended:

- Which observable properties make cases equivalent for this decision? Is the fact about a study, dataset, sample or individual observation? Shared membership alone does not establish a shared answer.
- Which cases were used to build the rule, and which separate cases test it? Include relevant differences between studies or datasets and plausible counterexamples.
- What errors, coverage and abstentions were actually observed, against what reference answers? A few shown uses or the agent's confidence do not establish population accuracy.
- Are applicability and abstention conditions explicit and executable where possible? Can selection, execution and provenance recording run in a batch without model intervention for each record?
- Which exceptions can be grouped, and what sample of automated results should be checked for failures within the claimed scope?

If support is insufficient, narrow the scope, gather the missing evidence or keep the result provisional. Do not invent an accuracy threshold or enlarge the budget to make a batch pass.

## Disagreement

- Which source version, inputs and procedure were actually used? Record execution output with `whitesnake run` and the competing reading as separate evidence.
- Was the input inside `applicability`, or did an `abstain_when` condition apply? Is the failure in the input, rule, implementation or criterion?
- Which decisions rely on the disputed result (`whitesnake affected <id>`)? What evidence supports continuing within a narrower scope?

Preserve contrary evidence in `rebuttal.evidence`. Record an unresolved interpretation as proposed; investigate a software failure rather than simply lowering confidence. Use `correct` for a researcher correction and the existing lifecycle commands for transitions. Never edit derived procedure state directly.

**A procedure you want to rewrite:**

- What recorded fact licenses the rewrite: a correction, a failing case, a check suspension, two timings on the same inputs? Without one, reuse.
- Does the new version pass every case the old one got right (`whitesnake procedure compare`)? A fix in one place and a regression in another is a different procedure, not a better one; the diverging cases are the researcher's.
- Is the justification checkable from the records it cites, or only readable?

## Verification

- Do the checks support the specific claim being made, on the current inputs and procedure? Store validation checks structure and references; verify the task's results separately.
- Are failures, unprocessed records, exclusions and abstentions accounted for? Report them alongside coverage and observed error.
- Is a claimed cost reduction supported by measured usage and a stated comparison, including development, orchestration, retries, delegation and verification? Keep estimates distinct from measurements.
- Can another agent follow the recorded evidence and criteria, reproduce the relevant checks and identify the remaining questions?

Run missing checks appropriate to the claim. Reuse evidence that still applies; rerun checks invalidated by changes. If a check is unavailable, report the limitation instead of claiming it passed.

## Record and reuse the review

Use existing record types and CLI operations; no new frontmatter fields are required:

- Keep a brief review in the relevant decision body: **trigger and scope; findings and evidence; choice and who made it; outcome and conditions for reopening**. Outcomes may be proceeding within scope, narrowing, revising, or seeking a user decision. Record findings, not a transcript of internal reasoning.
- Put excerpts, measurements and command outputs in `evidence`. Link them through `data` or `rebuttal.evidence`; a prose citation alone is insufficient.
- Use a `decision` of `kind: choice` for a reusable methodological choice and `kind: criterion` for a rule that licenses annotations. Cite criteria in `warrant`, methodological choices in `backing`, and procedure dependencies in `depends_on`. Preserve status and scope; an agent proposal is not a user-approved criterion.
- Create a `question` only for a material unresolved issue, with `why` explaining what depends on it. A later decision links to it through `answers`; update the question's `answered_by` and `status` through the CLI when resolved.
- Record substantive review work in an episode; decisions still come from leaf episodes. Reuse a shared review decision across a batch through explicit links, while keeping each result's evidence and scope. Update a procedure's `applicability`, `abstain_when` and `regression_cases` through the CLI when the review changes them.

For example, an accepted criterion already resolving an ambiguity needs no new user question. A new propagation rule with only examples used to construct it needs independent validation before broad use. A missing preference about error versus abstention needs a user choice; the selection of a parsing library usually does not.
