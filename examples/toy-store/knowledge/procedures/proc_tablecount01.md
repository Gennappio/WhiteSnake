---
id: proc_tablecount01
title: Sum a column of the participant-flow table
created: 2026-10-01T09:20:00.000Z
created_by: fixture:make-toy
type: procedure
state: provisional
resolution: code
entrypoint: procedures/table_counts/run.py
uses:
  - dec_choice0tabl4
applicability:
  - the paper has a markdown table with per-arm rows and a column whose header contains the wanted word (Randomised, Analysed)
abstain_when:
  - counts appear only in prose or in a figure
  - the table has merged or multi-line cells
regression_cases:
  - procedures/table_counts/cases/p01.json
promoted_from:
  - ep_p01nrand0000
  - ep_p01nanal0000
qualified_on:
  harness: claude
  model: fixture
history:
  - at: 2026-10-01T09:20:00.000Z
    from: null
    to: provisional
    caused_by: turn_claude_toyseed0001_0001
    reason: written while annotating P01 and reused for both count fields
counters:
  shown_uses: 1
  corrections: 0
produced_by: ep_p01root00000
caused_by: turn_claude_toyseed0001_0001
---

Run: python3 procedures/table_counts/run.py corpus/P0X.md Randomised
Output JSON has rows per arm and the total excluding any Total row. Record the output as execution evidence.
