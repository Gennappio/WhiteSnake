import { z } from "zod";
import { NODE_TYPES, type NodeType } from "./ids.js";

const Id = z.string().min(3);
const IdList = z.array(Id).default([]);
const Iso = z.string().min(10);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex expected");

const common = {
  id: Id,
  title: z.string().min(1),
  created: Iso,
  created_by: z.string().min(1),
};

export const QuestionSchema = z.strictObject({
  ...common,
  type: z.literal("question"),
  status: z.enum(["open", "answered", "retired"]).default("open"),
  why: z.string().default(""),
  raised_in: Id.nullable().default(null),
  answered_by: IdList,
  caused_by: Id.nullable().default(null),
});

export const DECISION_KINDS = ["annotation", "criterion", "choice"] as const;
export const DECISION_STATUSES = ["proposed", "active", "needs_review", "superseded", "retired"] as const;
export const FRAGILITIES = ["mechanical", "interpretive", "analogical", "absence"] as const;

export const DecisionSchema = z
  .strictObject({
    ...common,
    type: z.literal("decision"),
    kind: z.enum(DECISION_KINDS),
    status: z.enum(DECISION_STATUSES).default("proposed"),
    claim: z.string().min(1),
    qualifier: z.strictObject({
      confidence: z.number().min(0).max(1),
      scope: z.string().default(""),
    }),
    fragility: z.enum(FRAGILITIES),
    target: z
      .strictObject({
        unit: z.string().min(1),
        field: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
      .nullable()
      .default(null),
    data: IdList,
    warrant: IdList,
    backing: IdList,
    rebuttal: z
      .strictObject({ text: z.string().default(""), evidence: IdList })
      .default({ text: "", evidence: [] }),
    depends_on: IdList,
    supersedes: IdList,
    answers: Id.nullable().default(null),
    produced_by: Id.nullable().default(null),
    caused_by: Id.nullable().default(null),
    shown_at: IdList,
  })
  .refine((d) => d.kind !== "annotation" || d.target !== null, {
    message: "annotation decisions require target {unit, field, value}",
    path: ["target"],
  });

export const EvidenceSchema = z
  .strictObject({
    ...common,
    type: z.literal("evidence"),
    kind: z.enum(["excerpt", "observation", "execution"]),
    locator: z.strictObject({
      artifact: Id.nullable().default(null),
      path: z.string().nullable().default(null),
      page: z.number().int().nullable().default(null),
      table: z.string().nullable().default(null),
      section: z.string().nullable().default(null),
      span: z.string().nullable().default(null),
    }),
    hash: Sha256,
    /** For kind "execution": what exactly ran, where, with which inputs, and how it ended. */
    execution: z
      .strictObject({
        command: z.string(),
        cwd: z.string().default("."),
        exit_code: z.number().int(),
        duration_ms: z.number().int().nullable().default(null),
        platform: z.string().nullable().default(null),
        input_hashes: z.record(z.string(), Sha256).default({}),
        truncated: z.boolean().default(false),
      })
      .nullable()
      .default(null),
    produced_by: Id.nullable().default(null),
    caused_by: Id.nullable().default(null),
  })
  .refine((e) => e.locator.artifact !== null || e.locator.path !== null, {
    message: "locator requires an artifact id or a path",
    path: ["locator"],
  });

export const ArtifactSchema = z.strictObject({
  ...common,
  type: z.literal("artifact"),
  sha256: Sha256,
  path: z.string().min(1),
  source_uri: z.string().nullable().default(null),
  mime: z.string().nullable().default(null),
  size: z.number().int().nullable().default(null),
  caused_by: Id.nullable().default(null),
});

export const PROCEDURE_STATES = ["provisional", "trusted", "suspended", "retired"] as const;
export const PROCEDURE_RESOLUTIONS = ["code", "frozen_prompt", "skill"] as const;

export const ProcedureSchema = z.strictObject({
  ...common,
  type: z.literal("procedure"),
  state: z.enum(PROCEDURE_STATES).default("provisional"),
  resolution: z.enum(PROCEDURE_RESOLUTIONS),
  entrypoint: z.string().min(1),
  uses: IdList,
  applicability: z.array(z.string()).default([]),
  abstain_when: z.array(z.string()).default([]),
  regression_cases: z.array(z.string()).default([]),
  promoted_from: IdList,
  qualified_on: z.strictObject({ harness: z.string(), model: z.string() }).nullable().default(null),
  history: z
    .array(
      z.strictObject({
        at: Iso,
        from: z.string().nullable(),
        to: z.string(),
        caused_by: Id.nullable().default(null),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  counters: z
    .strictObject({ shown_uses: z.number().int().default(0), corrections: z.number().int().default(0) })
    .default({ shown_uses: 0, corrections: 0 }),
  produced_by: Id.nullable().default(null),
  caused_by: Id.nullable().default(null),
});

export const EPISODE_RESOLUTIONS = ["cached", "code", "frozen_prompt", "agent"] as const;
export const EPISODE_OUTCOMES = ["open", "success", "failure", "abstained", "corrected"] as const;

export const EpisodeSchema = z.strictObject({
  ...common,
  type: z.literal("episode"),
  question: Id.nullable().default(null),
  parent: Id.nullable().default(null),
  resolution: z.enum(EPISODE_RESOLUTIONS),
  uses: IdList,
  produces: IdList,
  children: z.array(z.union([Id, z.strictObject({ store: z.string(), id: z.string() })])).default([]),
  outcome: z.enum(EPISODE_OUTCOMES).default("open"),
  input_hash: z.string().nullable().default(null),
  started: Iso,
  ended: Iso.nullable().default(null),
  caused_by: Id.nullable().default(null),
});

export const SessionSchema = z.strictObject({
  ...common,
  type: z.literal("session"),
  harness: z.enum(["claude", "codex", "stub"]),
  native_id: z.string(),
  cwd: z.string(),
  git_branch: z.string().nullable().default(null),
  log_path: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  started: Iso,
  ended: Iso.nullable().default(null),
});

export const TurnSchema = z.strictObject({
  ...common,
  type: z.literal("turn"),
  session: Id,
  index: z.number().int().min(1),
  native_id: z.string().nullable().default(null),
  prompt_excerpt: z.string(),
  prompt_hash: Sha256,
  timestamp: Iso,
});

export const TemplateSchema = z.strictObject({
  ...common,
  type: z.literal("template"),
  compacted_from: z.strictObject({ count: z.number().int(), commit: z.string(), ids: z.array(z.string()) }),
  summary: z.string(),
  locators: z.array(z.unknown()).default([]),
  negative_examples: z.array(z.string()).default([]),
  caused_by: Id.nullable().default(null),
});

export type Question = z.infer<typeof QuestionSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Procedure = z.infer<typeof ProcedureSchema>;
export type Episode = z.infer<typeof EpisodeSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type Node = Question | Decision | Evidence | Artifact | Procedure | Episode | Session | Turn | Template;

export const SCHEMAS: Record<NodeType, z.ZodType> = {
  question: QuestionSchema,
  decision: DecisionSchema,
  evidence: EvidenceSchema,
  artifact: ArtifactSchema,
  procedure: ProcedureSchema,
  episode: EpisodeSchema,
  session: SessionSchema,
  turn: TurnSchema,
  template: TemplateSchema,
};

export interface SchemaIssue {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; node: Node } | { ok: false; issues: SchemaIssue[]; type: NodeType | null };

export function nodeTypeOf(raw: unknown): NodeType | null {
  if (!raw || typeof raw !== "object") return null;
  const t = (raw as Record<string, unknown>)["type"];
  return typeof t === "string" && (NODE_TYPES as readonly string[]).includes(t) ? (t as NodeType) : null;
}

/** Parse raw frontmatter into a typed node, applying defaults. */
export function parseNode(raw: unknown): ParseResult {
  const type = nodeTypeOf(raw);
  if (!type) return { ok: false, type: null, issues: [{ path: "type", message: "missing or unknown node type" }] };
  const result = SCHEMAS[type].safeParse(raw);
  if (result.success) return { ok: true, node: result.data as Node };
  return {
    ok: false,
    type,
    issues: result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  };
}

/** Status-like field used for listings and the frontier, per type. */
export function statusOf(node: Node): string {
  switch (node.type) {
    case "decision":
    case "question":
      return node.status;
    case "procedure":
      return node.state;
    case "episode":
      return node.outcome;
    default:
      return "";
  }
}

export function kindOf(node: Node): string {
  switch (node.type) {
    case "decision":
    case "evidence":
      return node.kind;
    case "procedure":
      return node.resolution;
    case "episode":
      return node.resolution;
    default:
      return "";
  }
}
