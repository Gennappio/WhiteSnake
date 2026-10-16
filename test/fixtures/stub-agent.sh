#!/bin/sh
# Deterministic stand-in for a coding agent in tests. Reads the prompt on stdin, works in the current store
# through the CLI like a real agent would, and prints the structured answer the schema asks for.
set -e
PROMPT=$(cat)
case "$PROMPT" in
  *'"answer": string'*)
    printf '{"answer":"P01 counts 115 analysed participants because Table 1 reports the ITT column per arm.","records":["dec_p01nanal0000","ev_p01table1000","dec_crit0analyz1"],"confidence":0.9}\n'
    ;;
  *)
    EP=$(autosoft episode open "Delegated task (stub)" --resolution agent --uses dec_crit0random2)
    EV=$(autosoft add evidence --json-in "{\"title\":\"Stub excerpt\",\"kind\":\"excerpt\",\"locator\":{\"artifact\":\"art_p02b8n4p0r5y\",\"table\":\"Table 1\"},\"produced_by\":\"$EP\"}" --body "| Aquatic exercise | 42 | 41 |")
    DEC=$(autosoft add decision --json-in "{\"title\":\"P02 n_randomized_total (stub)\",\"kind\":\"annotation\",\"status\":\"active\",\"claim\":\"84 randomised\",\"qualifier\":{\"confidence\":0.9,\"scope\":\"P02\"},\"fragility\":\"mechanical\",\"target\":{\"unit\":\"P02\",\"field\":\"n_randomized_total\",\"value\":84},\"data\":[\"$EV\"],\"warrant\":[\"dec_crit0random2\"],\"produced_by\":\"$EP\"}")
    autosoft episode close "$EP" --produces "$EV" "$DEC" >/dev/null
    printf '{"status":"completed","result":"P02 randomised 84 (42 + 42) from Table 1.","episode_id":"%s","decision_ids":["%s"],"evidence_ids":["%s"],"uncertainties":[],"new_questions":[]}\n' "$EP" "$DEC" "$EV"
    ;;
esac
