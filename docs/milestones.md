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

**Prove dal vivo superate su entrambi gli harness (2026-10-16); resta il test con giudizio umano sul corpus reale.**

Test deterministici: 34 verdi al momento della prima prova dal vivo (aggiunti: ciclo di vita con promozione a `trusted` dopo tre risultati mostrati, `correct` con sospensione della procedura, sostituzione della decisione e propagazione di `needs_review`, hook Stop che registra come mostrate le decisioni citate nel messaggio finale, pagina di revisione, guardia sulle scritture via shell in `knowledge/`, parser dei rollout Codex).

Prova dal vivo a tre sessioni (`npm run e2e:m2`): **superata con Claude Code e con Codex**. Claude Code:

| Fase | Durata | Esito |
|---|---|---|
| A. Annotazione di P02 e P03 | 135 s | store valido, 6 catene complete; `proc_tablecount01` promossa a `trusted` senza intervento umano, con 5 usi mostrati registrati dallo Stop hook |
| B. Il ricercatore cambia il criterio della popolazione analizzata | 45 s | l'agente ha usato `autosoft correct dec_crit0analyz1`; le tre annotazioni `n_analyzed_total` (P01, P02, P03) sono passate a `needs_review`; le sei annotazioni di randomizzati e outcome sono rimaste `active` con gli stessi valori; creato un nuovo criterio che sostituisce il vecchio |
| C. Arriva P04 | 97 s | 3 catene complete e 3 valori corretti; episodi che riusano la procedura trusted; numero di procedure invariato; quota di episodi risolti senza agente 0,50 contro 0,375 della fase A |

Codex (`--harness codex --model gpt-5.6-sol`):

| Fase | Durata | Esito |
|---|---|---|
| A | 141 s | store valido, 6 catene complete, procedura promossa a `trusted` con 5 usi mostrati; quota senza agente 0,50 |
| B | 77 s | `autosoft correct dec_crit0analyz1` invocato; le tre annotazioni `n_analyzed_total` in `needs_review`; le altre sei intatte; nuovo criterio che sostituisce il vecchio |
| C | 96 s | 3 catene complete e 3 valori corretti; procedura riusata; procedure 1 → 1; quota senza agente 0,50 |

Codex come agente di lavoro: la CLI installata (0.150.1) rifiuta il modello configurato `gpt-6-astra`; con `--model gpt-5.6-sol` gli hook di progetto scattano (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) e il compito di M1 (`npm run e2e:m1 -- --harness codex --model gpt-5.6-sol --runs 3`) è passato **3 run su 3**: store valido, 6 catene complete e 6 valori corretti per run, `affected` esatto, primo accesso allo store via CLI, zero letture dirette, zero scritture negate. Durate 143, 243 e 131 secondi. Codex esegue ogni passo come programma JavaScript con più comandi shell dentro; gli hook ricevono comunque un evento per singolo comando.

## M3 — Delega simulata, branching, passaggio di consegne

**Parti deterministiche chiuse il 2026-10-16; prova di passaggio dal vivo superata sui punti sostanziali, delega rieseguita dopo una correzione (vedi sotto).**

Test deterministici: 44 verdi, di cui per M3: `export` con manifest e `check` (integrità rilevata a un byte di differenza, export con e senza storia, rifiuto di uno store con modifiche non committate), rami per padre (worktree, rebase all'apertura, merge additivo, conflitto su una decisione rifiutato con uscita 4 e main intatto, rebase in conflitto rifiutato con uscita 3), `delegate` con runner stub (lavoro del figlio sul ramo del padre, evidenza di esecuzione e episodio con figlio remoto nel padre), `ask` con stub, `gate` con snapshot del contratto (44 comandi).

Prova di passaggio (`npm run e2e:m3`, Claude Code produce → Codex eredita in directory pulita, modello `gpt-5.6-sol`):

| Passo | Esito |
|---|---|
| Claude Code annota P02 e P03 nello store di origine | store valido, 144 s |
| `autosoft export` → copia pulita con manifest; `autosoft check` | ok: 53 record, 0 discrepanze, storia inclusa |
| Codex spiega tre annotazioni tramite `autosoft ask` | **3/3**: ogni risposta cita la decisione, almeno un'evidenza e il criterio; confidenza 0,99–1 |
| Codex registra il cambio di criterio | `autosoft correct dec_crit0analyz1` invocato; le tre annotazioni `n_analyzed_total` in `needs_review`; le altre sei intatte; nuovo criterio che sostituisce il vecchio |
| Codex annota P04 nella copia ereditata | 3 catene complete e 3 valori corretti; procedura trusted riusata; applica la nuova regola notando che P04 non riporta la popolazione per protocollo |
| Delega da uno store padre al figlio ereditato | fallita al primo tentativo: lo schema di output aveva una proprietà facoltativa e la modalità stretta di Codex richiede che ogni proprietà sia obbligatoria; corretto (campo obbligatorio e annullabile). Rieseguita dal vivo con Codex: stato `completed`, risposta che cita la decisione del figlio, due evidenze e il criterio; nel padre episodio con figlio remoto, evidenza di esecuzione e artefatto; store valido |
| Domande rivolte al ricercatore | 0 rilevate dall'euristica; le risposte complete sono in `docs/handoff-answers-2026-10-16.md` per il giudizio umano |

Nota sul rilevamento: nei rollout di Codex i comandi sono annidati in programmi JavaScript; il log degli hook (`.autosoft/hooks.log`) è la fonte autorevole dei comandi eseguiti ed è ora usato dai test insieme alla trascrizione.

## M4 — Compattazione, collasso, sublation

**Implementata e provata dal vivo il 2026-10-16 sullo store giocattolo; la prova sullo store reale attende il corpus.**

Test deterministici (3 nuovi, suite a 44 verdi): `gc` lascia intatto uno store in cui tutto è vivo, compatta un sottoalbero freddo e fallito in un nodo `template` con esempi negativi, localizzatori, elenco degli id sostituiti e commit di origine, lascia la provenienza viva byte-identica, è idempotente alla seconda applicazione e reversibile dalla storia git; `collapse` rifiuta un sottoalbero che richiede ancora l'agente e compone una procedura a passi da due episodi risolti con codice; `recheck` ritira una procedura che il modello riproduce e conserva quella che non riproduce.

Prova dal vivo (`npm run e2e:m4`): **superata con Claude Code e con Codex (`--harness codex --model gpt-5.6-sol`)**, con lo stesso esito. Il modello da solo riproduce il caso di regressione della procedura `table_counts` (somma 120 su P01) e la procedura viene ritirata per sublation; non riesce a produrre lo sha256 di un file (risposta nulla) e quella procedura resta provvisoria; `why` su P01 risolve ancora alla procedura ritirata; stati finali `provisional=1, retired=1`; store valido.
