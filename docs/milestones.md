# Milestone

Registro degli esiti delle milestone del piano (vedi `DESIGN.md`, sezione Milestone). Ogni milestone si chiude solo con il suo test superato.

## M1 — Store, CLI, skill, hook: un agente su un caso giocattolo

**Chiusa il 2026-10-16.**

Test deterministici (`npm test`): 29 verdi. Coprono schemi e identificativi, il validatore con sette corruzioni seminate (arco pendente, arco verso il tipo sbagliato, ID duplicato, claim mancante, cache di stato incoerente, directory di tipo sconosciuto, corpo dell'evidenza manomesso), la ricostruzione byte-identica dell'indice, i golden di `why`, `affected`, `precedent`, `frontier` e `timeline`, l'ingestione idempotente dei log di Claude Code e di Codex, gli hook, `add`/`set`/`link` con rifiuto dei riferimenti errati, e l'autorevolezza delle citazioni dichiarate in `affected`.

Test dal vivo (`npm run e2e:m1 -- --runs 3`): una sessione `claude -p` reale annota P02 e P03 in una copia pulita dello store giocattolo.

- Prima serie: 2 run su 3. Nel terzo l'agente aveva appeso tutti i criteri agli episodi radice dei paper e prodotto le decisioni direttamente da lì, così il cambio del criterio ITT raggiungeva 7 annotazioni invece di 3.
- Correzione: in `affected` le citazioni dichiarate da una decisione (`warrant`, `backing`, `depends_on`) sono autorevoli rispetto alla propagazione via episodio; il validatore emette gli avvisi `W_COARSE_EPISODE` e `W_UNCITED_CRITERION`; la skill prescrive un episodio foglia per decisione.
- Seconda serie: 3 run su 3.

| Run | Durata | Turni | Costo | Catene complete | Valori corretti | Letture dirette di knowledge/ | Scritture negate | Hook |
|---|---|---|---|---|---|---|---|---|
| 1 | 108 s | 15 | 0,34 $ | 6/6 | 6/6 | 0 | 0 | SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd |
| 2 | 168 s | 24 | 0,49 $ | 6/6 | 6/6 | 0 | 0 | come sopra, più PreToolUse |
| 3 | 155 s | 22 | 0,44 $ | 6/6 | 6/6 | 0 | 0 | come sopra, più PreToolUse |

In tutti i run: `validate` senza errori, indice byte-identico dopo ricostruzione, `affected` dopo il cambio di criterio uguale all'insieme atteso, primo accesso allo store tramite CLI.

Osservazioni qualitative: l'agente ha trovato da solo la discrepanza deliberata di P03 tra prosa (147 analizzati) e tabella (148), ha applicato la scelta "tabella prima della prosa" già nello store citandola come backing, ha registrato la frase discordante come evidenza del rebuttal, ha abbassato la confidenza a 0,7 con fragilità interpretativa, ha riusato la procedura `table_counts` per i quattro conteggi registrandone l'output come evidenza di esecuzione.

Aperto per M2: Codex come agente di lavoro, stati delle procedure derivati dagli eventi, `correct` e `shown`, pagina HTML di revisione, corpus reale.

## M2 — Ciclo di vita delle procedure, osservabilità, entrambi gli harness

**In corso (2026-10-16).**

Test deterministici: 34 verdi al momento della prima prova dal vivo (aggiunti: ciclo di vita con promozione a `trusted` dopo tre risultati mostrati, `correct` con sospensione della procedura, sostituzione della decisione e propagazione di `needs_review`, hook Stop che registra come mostrate le decisioni citate nel messaggio finale, pagina di revisione, guardia sulle scritture via shell in `knowledge/`, parser dei rollout Codex).

Prova dal vivo a tre sessioni con Claude Code (`npm run e2e:m2`): **superata**.

| Fase | Durata | Esito |
|---|---|---|
| A. Annotazione di P02 e P03 | 135 s | store valido, 6 catene complete; `proc_tablecount01` promossa a `trusted` senza intervento umano, con 5 usi mostrati registrati dallo Stop hook |
| B. Il ricercatore cambia il criterio della popolazione analizzata | 45 s | l'agente ha usato `autosoft correct dec_crit0analyz1`; le tre annotazioni `n_analyzed_total` (P01, P02, P03) sono passate a `needs_review`; le sei annotazioni di randomizzati e outcome sono rimaste `active` con gli stessi valori; creato un nuovo criterio che sostituisce il vecchio |
| C. Arriva P04 | 97 s | 3 catene complete e 3 valori corretti; episodi che riusano la procedura trusted; numero di procedure invariato; quota di episodi risolti senza agente 0,50 contro 0,375 della fase A |

Codex come agente di lavoro: la CLI installata (0.150.1) rifiuta il modello configurato `gpt-6-astra`; con `--model gpt-5.6-sol` gli hook di progetto scattano (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) e il compito di M1 (`npm run e2e:m1 -- --harness codex --model gpt-5.6-sol --runs 3`) è passato **3 run su 3**: store valido, 6 catene complete e 6 valori corretti per run, `affected` esatto, primo accesso allo store via CLI, zero letture dirette, zero scritture negate. Durate 143, 243 e 131 secondi. Codex esegue ogni passo come programma JavaScript con più comandi shell dentro; gli hook ricevono comunque un evento per singolo comando.
