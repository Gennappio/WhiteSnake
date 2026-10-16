# Record types

Every node is a Markdown file `knowledge/<type-dir>/<id>.md` with YAML frontmatter and an optional body. Ids are `prefix_` plus twelve lowercase alphanumerics (`dec_`, `ev_`, `art_`, `proc_`, `ep_`, `q_`, `tpl_`); sessions and turns derive their ids from the harness session (`ses_claude_…`, `turn_claude_…_0003`). The CLI generates ids, `created`, `created_by` and `caused_by` for you.

Edges are frontmatter fields holding ids. Their direction is fixed: a decision points to its evidence (`data`), to the criterion that licenses it (`warrant`), to the episode that produced it (`produced_by`); an episode points to the procedures and decisions it `uses` and to what it `produces`. `autosoft affected <id>` walks these edges backwards to find everything that relies on a node.

## decision (`knowledge/decisions/`)

| field | meaning |
|---|---|
| `kind` | `annotation` (a value for a cell), `criterion` (a rule others cite as warrant), `choice` (a methodological choice) |
| `status` | `proposed` → `active`; `needs_review` after a correction upstream; `superseded`, `retired` |
| `claim` | one sentence stating what is held true |
| `qualifier` | `{confidence: 0..1, scope: "where it holds / open question ids"}` |
| `fragility` | `mechanical`, `interpretive`, `analogical`, `absence` |
| `target` | annotation only: `{unit, field, value}` |
| `data` | evidence ids the claim rests on |
| `warrant` | criterion decision ids that license the inference |
| `backing` | evidence or decisions that justify the warrant itself (optional) |
| `rebuttal` | `{text, evidence}`: conditions under which the claim would be wrong |
| `depends_on` | other decisions or procedures whose change should trigger re-examination |
| `supersedes`, `answers`, `produced_by`, `caused_by`, `shown_at` | links to the replaced decision, the question answered, the episode, the prompt, the turns where it was shown |

Body: the rationale in a few lines. Example:

```
autosoft add decision --json-in '{
  "title": "P02 n_analyzed_total",
  "kind": "annotation", "status": "active",
  "claim": "80 participants were analysed in the ITT population (41 + 39)",
  "qualifier": {"confidence": 0.9, "scope": "P02; ITT population per criterion"},
  "fragility": "mechanical",
  "target": {"unit": "P02", "field": "n_analyzed_total", "value": 80},
  "data": ["ev_p02table1aaa"], "warrant": ["dec_crit0analyz1"],
  "produced_by": "ep_p02nanal0000"
}' --body "Table 1 reports ITT analysed counts per arm; summed with procedures/table_counts."
```

## evidence (`knowledge/evidence/`)

`kind`: `excerpt` (verbatim from a source), `observation` (something you measured), `execution` (output of a script). `locator`: `{artifact, path, page, table, section, span}` with at least `artifact` or `path`. `hash` is the sha256 of the body and is computed by the CLI. Body: the verbatim excerpt or the raw output. Keep excerpts short and exact.

## artifact (`knowledge/artifacts/`)

A source file: `path` (relative to the store), `sha256`, optional `source_uri`, `mime`, `size`. Evidence points to artifacts through `locator.artifact`.

## procedure (`knowledge/procedures/`)

A reusable way of doing something: `resolution` (`code`, `frozen_prompt`, `skill`), `entrypoint` (e.g. `procedures/table_counts/run.py`), `applicability` and `abstain_when` (plain-language conditions), `regression_cases` (paths to cases), `promoted_from` (episodes it was distilled from), `uses`. `state` (`provisional`, `trusted`, `suspended`, `retired`), `history` and `counters` are derived by the CLI: never set them. Body: how to run it, inputs, outputs.

## episode (`knowledge/episodes/`)

The unit of work. Keep a two-level shape: a parent episode per unit (paper) with `children`, and one leaf episode per decision carrying `uses` and `produces`. Decisions must be produced by leaf episodes. `resolution`: how it was resolved (`cached`, `code`, `frozen_prompt`, `agent`). `question`, `parent`, `uses`, `produces`, `children`, `outcome` (`open`, `success`, `failure`, `abstained`, `corrected`), `input_hash`, `started`, `ended`. Body: what was tried, in order, including dead ends.

## question (`knowledge/questions/`)

Something unresolved: `why` (what depends on the answer), `status` (`open`, `answered`, `retired`), `raised_in`, `answered_by`.

## session, turn (`knowledge/sessions/`, `knowledge/turns/`)

Created by hooks and by `autosoft ingest` from the harness logs. A turn is one user prompt; every record's `caused_by` points to the turn during which it was created, so `autosoft timeline` shows what each prompt led to.
