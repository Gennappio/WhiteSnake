# whitesnake CLI cheat sheet

All commands accept `--json` for machine-readable output and `--store <dir>` to point at a store; by default the nearest `whitesnake.yaml` upwards from the working directory is used. From inside a store, `--store <other>` writes into the other store on your `parent/<your-id>` branch with your turn mirrored there (`--on-main` bypasses this for reconciliation).

| command | purpose |
|---|---|
| `whitesnake config` | mandate, harness, output unit and fields |
| `whitesnake frontier` | open questions, proposed decisions, provisional/suspended procedures, open episodes |
| `whitesnake precedent <words...> [--type decision procedure] [--limit 10]` | lexical search over decisions, procedures, questions, episodes |
| `whitesnake why <id \| unit/field>` | provenance tree: decision → criteria, evidence, locators, episode, prompt |
| `whitesnake affected <id>` | everything that transitively relies on a node |
| `whitesnake get <id \| unit/field>` | print one record |
| `whitesnake ls [type] [--status s] [--kind k]` | list records |
| `whitesnake add <type> --json-in '<json>' [--body "<text>" \| --body-file <path>]` | create a record (id, created, caused_by filled in) |
| `whitesnake run "<command>" --episode <id>` | run a command and record it as execution evidence in one step |
| `whitesnake procedure propose --from-evidence <ids...> [--name n]` | distil recorded executions into a procedure skeleton with regression cases |
| `whitesnake set <id> --json-in '<patch>' [--body ...]` | update a record |
| `whitesnake link <id> <field> <ids...>` | append references to an edge field |
| `whitesnake episode open <title> [--parent id] [--uses ids...]` / `whitesnake episode close <id> [--outcome o] [--produces ids...]` | bracket a unit of work |
| `whitesnake shown <ids...>` | record that these decisions were presented to the researcher (promotes procedures over time) |
| `whitesnake correct <id> --reason "<text>" [--value <json>]` | the researcher says a result is wrong: marks it, suspends the procedures behind it, flags dependents |
| `whitesnake resolve --unit U --field F [text]` | cached decision, trusted procedure, or agent work |
| `whitesnake kpi` | resolutions without agent, decisions by status, procedure transitions |
| `whitesnake render` | write review.html for the researcher |
| `whitesnake ask "<question>"` | ask an agent about the store; answer cites record ids |
| `whitesnake delegate --child <dir> --question "..."` | hand a question to a child store; its answer comes back as evidence |
| `whitesnake export <dir>` / `whitesnake check` | hand the store over, verify an imported copy |
| `whitesnake gc [--apply]` | compact cold subtrees nothing live needs; reversible via git |
| `whitesnake collapse <episode>` | one composed procedure from a deterministic subtree |
| `whitesnake procedure recheck <id> --harness h [--retire]` | can the model alone reproduce the regression cases? |
| `whitesnake validate` | check the whole store (exit 2 on errors; warnings do not fail) |
| `whitesnake index [--dump]` | rebuild the SQLite index |
| `whitesnake timeline [--session id]` | prompts and the records each one caused |
| `whitesnake turn` | current turn id |
| `whitesnake export-output` | regenerate `output/annotations.csv` from annotation decisions |
| `whitesnake ingest <log.jsonl>` | import a harness session log |
| `whitesnake doctor` | runtime and store health |

Quoting: pass `--json-in` in single quotes and use double quotes inside the JSON. For long bodies prefer `--body-file`.

Typical annotation of one field:

```
EP=$(whitesnake add episode --json-in '{"title":"P02 n_randomized_total","resolution":"agent","parent":"ep_…"}')
EV=$(whitesnake add evidence --json-in '{"title":"P02 Table 1 randomised","kind":"excerpt","locator":{"artifact":"art_…","section":"Table 1"},"produced_by":"'$EP'"}' --body "| Arm | Randomised | ... |")
DEC=$(whitesnake add decision --json-in '{"title":"P02 n_randomized_total","kind":"annotation","status":"active","claim":"84 randomised (42 + 42)","qualifier":{"confidence":0.95,"scope":"P02"},"fragility":"mechanical","target":{"unit":"P02","field":"n_randomized_total","value":84},"data":["'$EV'"],"warrant":["dec_crit0random2"],"produced_by":"'$EP'"}')
whitesnake set $EP --json-in '{"outcome":"success","ended":"2026-10-16T10:00:00Z","produces":["'$EV'","'$DEC'"]}'
```
