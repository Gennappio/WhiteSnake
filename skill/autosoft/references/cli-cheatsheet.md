# autosoft CLI cheat sheet

All commands accept `--json` for machine-readable output and `--store <dir>` to point at a store; by default the nearest `autosoft.yaml` upwards from the working directory is used.

| command | purpose |
|---|---|
| `autosoft config` | mandate, harness, output unit and fields |
| `autosoft frontier` | open questions, proposed decisions, provisional/suspended procedures, open episodes |
| `autosoft precedent <words...> [--type decision procedure] [--limit 10]` | lexical search over decisions, procedures, questions, episodes |
| `autosoft why <id \| unit/field>` | provenance tree: decision → criteria, evidence, locators, episode, prompt |
| `autosoft affected <id>` | everything that transitively relies on a node |
| `autosoft get <id \| unit/field>` | print one record |
| `autosoft ls [type] [--status s] [--kind k]` | list records |
| `autosoft add <type> --json-in '<json>' [--body "<text>" \| --body-file <path>]` | create a record (id, created, caused_by filled in) |
| `autosoft set <id> --json-in '<patch>' [--body ...]` | update a record |
| `autosoft link <id> <field> <ids...>` | append references to an edge field |
| `autosoft validate` | check the whole store (exit 2 on errors) |
| `autosoft index [--dump]` | rebuild the SQLite index |
| `autosoft timeline [--session id]` | prompts and the records each one caused |
| `autosoft turn` | current turn id |
| `autosoft export-output` | regenerate `output/annotations.csv` from annotation decisions |
| `autosoft ingest <log.jsonl>` | import a harness session log |
| `autosoft doctor` | runtime and store health |

Quoting: pass `--json-in` in single quotes and use double quotes inside the JSON. For long bodies prefer `--body-file`.

Typical annotation of one field:

```
EP=$(autosoft add episode --json-in '{"title":"P02 n_randomized_total","resolution":"agent","parent":"ep_…"}')
EV=$(autosoft add evidence --json-in '{"title":"P02 Table 1 randomised","kind":"excerpt","locator":{"artifact":"art_…","section":"Table 1"},"produced_by":"'$EP'"}' --body "| Arm | Randomised | ... |")
DEC=$(autosoft add decision --json-in '{"title":"P02 n_randomized_total","kind":"annotation","status":"active","claim":"84 randomised (42 + 42)","qualifier":{"confidence":0.95,"scope":"P02"},"fragility":"mechanical","target":{"unit":"P02","field":"n_randomized_total","value":84},"data":["'$EV'"],"warrant":["dec_crit0random2"],"produced_by":"'$EP'"}')
autosoft set $EP --json-in '{"outcome":"success","ended":"2026-10-16T10:00:00Z","produces":["'$EV'","'$DEC'"]}'
```
