import type { DatabaseSync } from "node:sqlite";
import type { IndexedNode } from "../index/queries.js";

export interface Kpi {
  episodes: { closed: number; by_resolution: Record<string, number>; resolved_without_agent: number };
  decisions: { by_status: Record<string, number>; shown: number; unshown: number };
  procedures: { by_state: Record<string, number> };
  transitions: { at: string; procedure: string; from: string | null; to: string; session: string | null }[];
  sessions: { session: string; harness: string; turns: number; decisions: number; promotions: number; demotions: number; corrections: number }[];
}

function count<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items.sort()) out[i] = (out[i] ?? 0) + 1;
  return out;
}

export function kpi(db: DatabaseSync): Kpi {
  const all = (db.prepare("SELECT json FROM nodes ORDER BY id").all() as { json: string }[]).map((r) => JSON.parse(r.json) as IndexedNode);
  const episodes = all.filter((n): n is IndexedNode & { type: "episode" } => n.type === "episode");
  const decisions = all.filter((n): n is IndexedNode & { type: "decision" } => n.type === "decision");
  const procedures = all.filter((n): n is IndexedNode & { type: "procedure" } => n.type === "procedure");
  const turns = all.filter((n): n is IndexedNode & { type: "turn" } => n.type === "turn");
  const sessions = all.filter((n): n is IndexedNode & { type: "session" } => n.type === "session");
  const turnSession = new Map(turns.map((t) => [t.id, t.session]));

  const closed = episodes.filter((e) => e.outcome !== "open");
  const byRes = count(closed.map((e) => e.resolution));
  const withoutAgent = closed.filter((e) => e.resolution !== "agent").length;

  const transitions = procedures
    .flatMap((p) => p.history.map((h) => ({ at: h.at, procedure: p.id, from: h.from, to: h.to, session: h.caused_by ? (turnSession.get(h.caused_by) ?? null) : null })))
    .sort((a, b) => a.at.localeCompare(b.at) || a.procedure.localeCompare(b.procedure));

  const perSession = sessions
    .map((s) => {
      const sTurns = turns.filter((t) => t.session === s.id).map((t) => t.id);
      const inSession = (turn: string | null) => !!turn && sTurns.includes(turn);
      return {
        session: s.id,
        harness: s.harness,
        turns: sTurns.length,
        decisions: decisions.filter((d) => inSession(d.caused_by)).length,
        promotions: transitions.filter((t) => t.session === s.id && t.to === "trusted").length,
        demotions: transitions.filter((t) => t.session === s.id && t.to === "suspended").length,
        corrections: decisions.filter((d) => inSession(d.caused_by) && d.kind === "annotation" && d.status === "superseded").length,
      };
    })
    .sort((a, b) => a.session.localeCompare(b.session));

  return {
    episodes: { closed: closed.length, by_resolution: byRes, resolved_without_agent: closed.length ? Math.round((withoutAgent / closed.length) * 1000) / 1000 : 0 },
    decisions: { by_status: count(decisions.map((d) => d.status)), shown: decisions.filter((d) => d.shown_at.length > 0).length, unshown: decisions.filter((d) => d.shown_at.length === 0).length },
    procedures: { by_state: count(procedures.map((p) => p.state)) },
    transitions,
    sessions: perSession,
  };
}

export function renderKpi(k: Kpi): string {
  const fmt = (r: Record<string, number>) => Object.entries(r).map(([a, b]) => `${a}=${b}`).join(", ") || "none";
  return [
    `Episodes closed: ${k.episodes.closed} (${fmt(k.episodes.by_resolution)}); resolved without agent: ${(k.episodes.resolved_without_agent * 100).toFixed(0)}%`,
    `Decisions: ${fmt(k.decisions.by_status)}; shown ${k.decisions.shown}, unshown ${k.decisions.unshown}`,
    `Procedures: ${fmt(k.procedures.by_state)}`,
    `Transitions: ${k.transitions.length}${k.transitions.length ? "\n" + k.transitions.map((t) => `  ${t.at}  ${t.procedure}  ${t.from ?? "-"} -> ${t.to}${t.session ? `  (${t.session})` : ""}`).join("\n") : ""}`,
    `Sessions:${k.sessions.length ? "\n" + k.sessions.map((s) => `  ${s.session} (${s.harness}) turns=${s.turns} decisions=${s.decisions} promotions=${s.promotions} demotions=${s.demotions} corrections=${s.corrections}`).join("\n") : " none"}`,
  ].join("\n");
}
