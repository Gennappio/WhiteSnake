import { ensureIndex } from "../index/db.js";
import { frontier, getNode, timeline, type IndexedNode } from "../index/queries.js";
import { kpi, type Kpi } from "../lifecycle/kpi.js";
import { loadConfig } from "../store/config.js";
import { loadStore } from "../store/files.js";
import { validateStore, warningsOf } from "../store/validate.js";
import { collapseWs, nowIso, truncate } from "../util.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const CSS = `
:root { --bg:#fbfbf9; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2dc; --card:#ffffff; --accent:#2f5d8a; --warn:#9a5b00; --bad:#a23b2a; --ok:#2e7d4f; --chip:#eef1f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#161716; --fg:#ecebe6; --muted:#a09f98; --line:#2d2e2b; --card:#1f201e; --accent:#8db5e0; --warn:#e0a948; --bad:#e07a68; --ok:#6fc08f; --chip:#2a2c29; } }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 64px }
h1 { font-size:22px; margin:0 0 4px } h2 { font-size:17px; margin:32px 0 12px; padding-top:16px; border-top:1px solid var(--line) } h3 { font-size:15px; margin:16px 0 8px }
.muted { color:var(--muted) } .mandate { margin:4px 0 16px }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin:16px 0 }
.tile { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px } .tile b { display:block; font-size:22px; font-weight:600 } .tile span { color:var(--muted); font-size:13px }
.chip { display:inline-block; background:var(--chip); border-radius:999px; padding:1px 8px; font-size:12px; margin-right:4px; white-space:nowrap }
.status-active,.state-trusted { color:var(--ok) } .status-needs_review,.state-suspended,.status-proposed,.state-provisional { color:var(--warn) } .status-superseded,.status-retired,.state-retired { color:var(--muted) }
code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--chip); padding:0 4px; border-radius:4px }
details { border:1px solid var(--line); border-radius:8px; background:var(--card); padding:8px 12px; margin:6px 0 } summary { cursor:pointer } details[open] > summary { margin-bottom:8px }
.turn { margin:12px 0 } .turn .prompt { font-weight:600 } .caused { margin:6px 0 0 16px; padding:0; list-style:none } .caused li { margin:3px 0 }
table { border-collapse:collapse; width:100%; font-size:14px } th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top } th { color:var(--muted); font-weight:600 }
.toulmin dt { color:var(--muted); font-size:12px; margin-top:6px } .toulmin dd { margin:0 } .excerpt { white-space:pre-wrap; font:13px ui-monospace,Menlo,monospace; background:var(--chip); padding:6px 8px; border-radius:6px; margin-top:4px }
input.filter { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font-size:14px; margin:8px 0 }
.empty { color:var(--muted); font-style:italic }
`;

function decisionDetails(db: ReturnType<typeof ensureIndex>, d: IndexedNode & { type: "decision" }): string {
  const ev = (ids: string[]) =>
    ids
      .map((id) => {
        const e = getNode(db, id);
        if (!e || e.type !== "evidence") return `<li><code>${esc(id)}</code></li>`;
        const loc = Object.entries(e.locator).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(", ");
        return `<li><code>${esc(id)}</code> ${esc(e.title)} <span class="muted">(${esc(loc)})</span><div class="excerpt">${esc(truncate(collapseWs(e.body), 400))}</div></li>`;
      })
      .join("");
  const refs = (ids: string[]) =>
    ids.length
      ? ids
          .map((id) => {
            const n = getNode(db, id);
            return `<li><code>${esc(id)}</code> ${esc(n?.title ?? "")}</li>`;
          })
          .join("")
      : '<li class="empty">none</li>';
  return `<dl class="toulmin">
  <dt>Claim</dt><dd>${esc(d.claim)}</dd>
  ${d.target ? `<dt>Target</dt><dd><code>${esc(d.target.unit)}/${esc(d.target.field)}</code> = <b>${esc(JSON.stringify(d.target.value))}</b></dd>` : ""}
  <dt>Qualifier</dt><dd>confidence ${esc(d.qualifier.confidence)}${d.qualifier.scope ? `; ${esc(d.qualifier.scope)}` : ""} · fragility <span class="chip">${esc(d.fragility)}</span></dd>
  <dt>Data (evidence)</dt><dd><ul class="caused">${d.data.length ? ev(d.data) : '<li class="empty">none</li>'}</ul></dd>
  <dt>Warrant (criteria)</dt><dd><ul class="caused">${refs(d.warrant)}</ul></dd>
  ${d.backing.length ? `<dt>Backing</dt><dd><ul class="caused">${refs(d.backing)}</ul></dd>` : ""}
  ${d.rebuttal.text || d.rebuttal.evidence.length ? `<dt>Rebuttal</dt><dd>${esc(d.rebuttal.text)}<ul class="caused">${d.rebuttal.evidence.length ? ev(d.rebuttal.evidence) : ""}</ul></dd>` : ""}
  ${d.depends_on.length ? `<dt>Depends on</dt><dd><ul class="caused">${refs(d.depends_on)}</ul></dd>` : ""}
  <dt>Provenance</dt><dd>episode <code>${esc(d.produced_by ?? "-")}</code> · prompt <code>${esc(d.caused_by ?? "-")}</code> · shown ${d.shown_at.length ? d.shown_at.map((t) => `<code>${esc(t)}</code>`).join(" ") : '<span class="muted">never</span>'}</dd>
  ${d.body ? `<dt>Rationale</dt><dd>${esc(d.body)}</dd>` : ""}
</dl>`;
}

function recordLine(db: ReturnType<typeof ensureIndex>, id: string): string {
  const n = getNode(db, id);
  if (!n) return `<li><code>${esc(id)}</code></li>`;
  const status = "status" in n ? n.status : "state" in n ? n.state : "outcome" in n ? n.outcome : "";
  const label = `<code>${esc(n.id)}</code> <span class="chip">${esc(n.type)}${"kind" in n && n.kind ? `/${esc(n.kind)}` : ""}</span> ${status ? `<span class="status-${esc(status)} state-${esc(status)}">${esc(status)}</span> ` : ""}${esc(n.title)}`;
  if (n.type === "decision") return `<li><details><summary>${label}</summary>${decisionDetails(db, n)}</details></li>`;
  return `<li>${label}</li>`;
}

function tiles(k: Kpi): string {
  const fmt = (r: Record<string, number>) => Object.entries(r).map(([a, b]) => `${a} ${b}`).join(" · ") || "none";
  return `<div class="tiles">
  <div class="tile"><b>${k.episodes.closed}</b><span>episodes closed</span></div>
  <div class="tile"><b>${(k.episodes.resolved_without_agent * 100).toFixed(0)}%</b><span>resolved without an agent</span></div>
  <div class="tile"><b>${Object.values(k.decisions.by_status).reduce((a, b) => a + b, 0)}</b><span>decisions · ${esc(fmt(k.decisions.by_status))}</span></div>
  <div class="tile"><b>${k.decisions.unshown}</b><span>decisions never shown to the researcher</span></div>
  <div class="tile"><b>${Object.values(k.procedures.by_state).reduce((a, b) => a + b, 0)}</b><span>procedures · ${esc(fmt(k.procedures.by_state))}</span></div>
  <div class="tile"><b>${k.transitions.length}</b><span>procedure transitions</span></div>
</div>`;
}

/** Static, self-contained review page generated from the index. Read-only by design: corrections go through the agent. */
export function renderReview(root: string): string {
  const cfg = loadConfig(root);
  const db = ensureIndex(root);
  const k = kpi(db);
  const f = frontier(db);
  const tl = timeline(db);
  const warnings = warningsOf(validateStore(loadStore(root)));
  const procedures = (db.prepare("SELECT json FROM nodes WHERE type = 'procedure' ORDER BY id").all() as { json: string }[]).map((r) => JSON.parse(r.json) as IndexedNode & { type: "procedure" });

  const reviewItems = [...f.needs_review, ...f.proposed_decisions].map((r) => recordLine(db, r.id)).join("");
  const questions = f.open_questions.map((q) => recordLine(db, q.id)).join("");
  const suspended = f.suspended_procedures.map((p) => recordLine(db, p.id)).join("");

  const timelineHtml = tl.length
    ? tl
        .map(
          (s) => `<h3><code>${esc(s.session)}</code> <span class="chip">${esc(s.harness)}</span> <span class="muted">${esc(s.started)}</span></h3>
${s.turns
  .map(
    (t) => `<div class="turn" data-text="${esc(`${t.prompt} ${t.caused.map((c) => `${c.id} ${c.title}`).join(" ")}`.toLowerCase())}">
  <div class="prompt">#${t.index} <span class="muted">${esc(t.timestamp)}</span> ${esc(t.prompt)}</div>
  <ul class="caused">${t.caused.length ? t.caused.map((c) => recordLine(db, c.id)).join("") : '<li class="empty">no records</li>'}</ul>
</div>`,
  )
  .join("")}`,
        )
        .join("")
    : '<p class="empty">No sessions ingested yet.</p>';

  const proceduresHtml = procedures.length
    ? `<table><thead><tr><th>Procedure</th><th>State</th><th>Resolution</th><th>Shown uses</th><th>Corrections</th><th>Applicability</th><th>History</th></tr></thead><tbody>${procedures
        .map(
          (p) => `<tr><td><code>${esc(p.id)}</code><br>${esc(p.title)}<br><span class="muted">${esc(p.entrypoint)}</span></td><td class="state-${esc(p.state)}">${esc(p.state)}</td><td>${esc(p.resolution)}</td><td>${p.counters.shown_uses}</td><td>${p.counters.corrections}</td><td>${p.applicability.map((a) => esc(a)).join("<br>")}${p.abstain_when.length ? `<br><span class="muted">abstain: ${p.abstain_when.map((a) => esc(a)).join("; ")}</span>` : ""}</td><td>${p.history.map((h) => `${esc(h.at.slice(0, 16))} ${esc(h.from ?? "-")} → ${esc(h.to)}<br><span class="muted">${esc(h.reason)}</span>`).join("<br>") || '<span class="empty">none</span>'}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : '<p class="empty">No procedures registered.</p>';

  const warningsHtml = warnings.length ? `<ul class="caused">${warnings.map((w) => `<li><code>${esc(w.code)}</code> ${esc(w.message)}</li>`).join("")}</ul>` : '<p class="empty">No recording warnings.</p>';

  db.close();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.name)} · review</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(cfg.name)} <span class="muted">(${esc(cfg.id)})</span></h1>
<p class="mandate">${esc(cfg.mandate || "No mandate stated.")}</p>
<p class="muted">Generated ${esc(nowIso())}. This page is read-only: to accept, correct or question a result, tell the agent and it will record the change.</p>
${tiles(k)}
<h2>To review</h2>
<h3>Decisions needing review or still proposed (${f.needs_review.length + f.proposed_decisions.length})</h3>
<ul class="caused">${reviewItems || '<li class="empty">none</li>'}</ul>
<h3>Open questions (${f.open_questions.length})</h3>
<ul class="caused">${questions || '<li class="empty">none</li>'}</ul>
<h3>Suspended procedures (${f.suspended_procedures.length})</h3>
<ul class="caused">${suspended || '<li class="empty">none</li>'}</ul>
<h2>Timeline by prompt</h2>
<input class="filter" type="search" placeholder="Filter turns by text or record id" oninput="for(const t of document.querySelectorAll('.turn')){t.style.display=t.dataset.text.includes(this.value.toLowerCase())?'':'none'}">
${timelineHtml}
<h2>Procedures</h2>
${proceduresHtml}
<h2>Recording warnings</h2>
${warningsHtml}
<h2>Procedure transitions</h2>
${k.transitions.length ? `<table><thead><tr><th>When</th><th>Procedure</th><th>From</th><th>To</th><th>Session</th></tr></thead><tbody>${k.transitions.map((t) => `<tr><td>${esc(t.at)}</td><td><code>${esc(t.procedure)}</code></td><td>${esc(t.from ?? "-")}</td><td class="state-${esc(t.to)}">${esc(t.to)}</td><td>${esc(t.session ?? "-")}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">none</p>'}
</main></body></html>
`;
}
