# Toulmin structure and fragility

A decision record follows Toulmin's model of argument so that a reviewer can attack it at the right joint.

| Toulmin | field | question it answers |
|---|---|---|
| Claim | `claim`, `target.value` | what do we hold? |
| Data (grounds) | `data` → evidence | on which excerpts or observations? |
| Warrant | `warrant` → criterion decisions | which rule licenses going from the data to the claim? |
| Backing | `backing` | why is the warrant itself acceptable here (protocol, researcher decision, precedent)? |
| Qualifier | `qualifier.confidence`, `qualifier.scope` | how strongly, and where, does it hold? |
| Rebuttal | `rebuttal.text`, `rebuttal.evidence` | what would make it wrong? |

A criterion is itself a decision (`kind: criterion`): its claim is the rule, its data are the sources of the rule (protocol text, researcher instruction turn), its rebuttal lists the cases where the rule should not be applied.

## Fragility

The fragility tag says how the claim could break; it drives review priority and what happens when a criterion changes.

- `mechanical`: the criterion applies directly and the value is read off the data (a table cell, a sum). Recomputable automatically if the criterion changes.
- `interpretive`: you chose among readings (which table is "the" flow table, which population is "analysed"). Must be re-read by a human if the criterion changes.
- `analogical`: you treated this unit like a precedent unit. Name the precedent decision in `backing`.
- `absence`: the value rests on something not being reported ("blinding not mentioned, therefore open-label"). This is an argument from ignorance: keep confidence low and spell out in `rebuttal.text` what report would overturn it.

When fragility is not `mechanical`, run the Walton checklist before recording.
