import { z } from "zod";
import { isRecord } from "#src/internal/json-record";
import { MEMORY_KINDS, type MemoryKind } from "./local-memory";

export const TEAM_MEMORY_ROUTE = { method: "POST", path: "/api/agent/v1/team-memory" } as const;
export type TeamMemoryEvidence = {
  kind: "task" | "message" | "artifact";
  id: string;
  revision?: number;
};
export type TeamMemoryRelation = {
  kind: "supersedes" | "conflicts_with";
  id: string;
  revision: number;
};
export type TeamMemoryDraft = {
  title: string;
  content: string;
  source: string;
  kind: MemoryKind;
  applicability: string;
  projectId?: string | null;
  pinned?: boolean;
  evidence?: TeamMemoryEvidence[];
  relations?: TeamMemoryRelation[];
  effectiveAt?: string | null;
};
export type TeamMemoryHead = TeamMemoryDraft & {
  id: string;
  revision: number;
  status: "active" | "archived";
  authorAgentId: string | null;
  authorUserId?: string | null;
  updatedAt: string;
  change?: {
    actorAgentId: string | null;
    actorUserId?: string | null;
    operation: string;
    reason: string;
    mergedFrom: { id: string; revision: number }[];
  };
};
export type TeamMemoryWrite = {
  requestId: string;
  reviewToken?: string;
  maintenanceToken?: string;
} & (
  | ({ operation: "create" } & TeamMemoryDraft)
  | ({ operation: "update"; id: string; revision: number; reason: string } & TeamMemoryDraft)
  | ({
      operation: "merge";
      id: string;
      revision: number;
      sources: { id: string; revision: number }[];
      reason: string;
    } & TeamMemoryDraft)
  | { operation: "archive" | "delete"; id: string; revision: number; reason: string }
  | { operation: "restore"; id: string; revision: number; fromRevision: number; reason: string }
);
export type TeamMemoryCatalogCommand =
  | { operation: "projects"; query?: string; offset?: number }
  | { operation: "project-create"; name: string; slug: string; description: string };
export type TeamMemoryMaintenanceCommand = { operation: "maintenance" };
export type TeamMemoryCommand =
  | TeamMemoryMaintenanceCommand
  | TeamMemoryCatalogCommand
  | ({ operation: "prepare" } & TeamMemoryDraft)
  | {
      operation: "search";
      query: string;
      offset?: number;
      projectId?: string | null;
      archived?: boolean;
      includeSuperseded?: boolean;
      includeWorkspace?: boolean;
      includeConflicts?: boolean;
    }
  | { operation: "list"; offset?: number; archived?: boolean; projectId?: string }
  | { operation: "get"; id: string; revision?: number }
  | { operation: "history"; id: string; offset?: number }
  | TeamMemoryWrite;
export const TEAM_MEMORY_MAINTENANCE_COMMAND = "coforge memory maintenance --scope team";
export const TEAM_MEMORY_MAINTENANCE_GUIDANCE =
  "Finish the person’s task first. Then inspect at most five entries within two minutes. Read full evidence; preserve important decisions, sources and history. Stop for new work. Never delete, unpin or mix Projects. Use maintenanceToken and normal reviewToken for each change.";
export type TeamMemoryResult = {
  status: "ok" | "review_required" | "deleted";
  entries: TeamMemoryHead[];
  projects?: { id: string; name: string; slug: string; description: string }[];
  maintenanceHint?: {
    projectId: string | null;
    observedEntries: number;
    observedBytes: number;
    incomplete: boolean;
    nextCommand: string;
    guidance: string;
  };
  maintenance?: { token: string; expiresAt: string; remaining: number; projectId: string | null };
  reviewRevision?: number;
  reviewToken?: string;
  nextOffset?: number;
  replayed?: boolean;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const evidenceKinds = ["task", "message", "artifact"] as const;
const relationKinds = ["supersedes", "conflicts_with"] as const;

function decodeReferences<K extends string>(
  value: unknown,
  kinds: readonly K[],
  field: "evidence" | "relations",
): { kind: K; id: string; revision?: number }[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error(`invalid_memory_${field}`);
  const seen = new Set<string>();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => !["kind", "id", "revision"].includes(key)) ||
      !kinds.includes(item.kind as K) ||
      typeof item.id !== "string" ||
      !UUID.test(item.id) ||
      (item.revision === undefined
        ? field === "relations"
        : !Number.isSafeInteger(item.revision) ||
          Number(item.revision) < (item.kind === "task" ? 0 : 1) ||
          Number(item.revision) > 2_147_483_647)
    )
      throw new Error(`invalid_memory_${field}`);
    const id = item.id.toLowerCase();
    const key = `${item.kind}:${id}:${item.revision ?? ""}`;
    if (seen.has(key)) throw new Error(`invalid_memory_${field}`);
    seen.add(key);
    return {
      kind: item.kind as K,
      id,
      ...(item.revision === undefined ? {} : { revision: Number(item.revision) }),
    };
  });
}

function decodeEffectiveAt(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("invalid_memory_effectiveAt");
  const normalized = new Date(value).toISOString();
  const canonical = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, fraction = "") => `.${fraction.padEnd(3, "0")}Z`,
  );
  if (normalized !== canonical) throw new Error("invalid_memory_effectiveAt");
  return normalized;
}

export function decodeTeamMemoryCommand(value: unknown): TeamMemoryCommand {
  if (!isRecord(value)) throw new Error("invalid_memory_command");
  const string = (key: string, max = 1_000, empty = false) => {
    const text = value[key];
    if (
      typeof text !== "string" ||
      (!empty && !text.trim()) ||
      text.length > max ||
      text.includes("\0")
    )
      throw new Error(`invalid_memory_${key}`);
    return text;
  };
  const uuid = (key: string) => {
    const id = string(key, 36);
    if (!UUID.test(id)) throw new Error(`invalid_memory_${key}`);
    return id.toLowerCase();
  };
  const number = (key: string, fallback?: number) => {
    const item = value[key] ?? fallback;
    if (
      typeof item !== "number" ||
      !Number.isSafeInteger(item) ||
      item < 0 ||
      (key === "offset" && item > 100_000)
    )
      throw new Error(`invalid_memory_${key}`);
    return item;
  };
  const operation = string("operation", 20);
  if (operation === "maintenance") {
    if (Object.keys(value).some((key) => key !== "operation"))
      throw new Error("invalid_memory_field");
    return { operation };
  }
  if (operation === "projects" || operation === "project-create") {
    const keys =
      operation === "projects"
        ? ["operation", "query", "offset"]
        : ["operation", "name", "slug", "description"];
    if (Object.keys(value).some((key) => !keys.includes(key)))
      throw new Error("invalid_memory_field");
    if (operation === "projects")
      return {
        operation,
        ...(value.query === undefined ? {} : { query: string("query", 200, true) }),
        offset: number("offset", 0),
      };
    const slug = string("slug", 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("invalid_memory_slug");
    return {
      operation,
      slug,
      name: string("name", 100),
      description: string("description", 2000, true),
    };
  }
  const draftKeys = [
    "title",
    "content",
    "source",
    "kind",
    "applicability",
    "projectId",
    "pinned",
    "evidence",
    "relations",
    "effectiveAt",
  ];
  const readKeys =
    operation === "search"
      ? [
          "query",
          "offset",
          "projectId",
          "archived",
          "includeSuperseded",
          "includeWorkspace",
          "includeConflicts",
        ]
      : operation === "list"
        ? ["offset", "archived", "projectId"]
        : operation === "get"
          ? ["id", "revision"]
          : ["id", "offset"];
  const writeKeys = [
    "requestId",
    "reviewToken",
    "maintenanceToken",
    ...(operation === "create" ? [] : ["id", "revision", "reason"]),
    ...(operation === "restore" ? ["fromRevision"] : []),
    ...(operation === "merge" ? ["sources"] : []),
  ];
  const hasDraft = ["prepare", "create", "update", "merge"].includes(operation);
  const allowed = new Set([
    "operation",
    ...(hasDraft ? draftKeys : []),
    ...(operation === "prepare"
      ? []
      : ["search", "list", "get", "history"].includes(operation)
        ? readKeys
        : writeKeys),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("invalid_memory_field");
  const project =
    value.projectId === undefined
      ? {}
      : {
          projectId:
            value.projectId === null && (hasDraft || operation === "search")
              ? null
              : uuid("projectId"),
        };
  if (value.archived !== undefined && typeof value.archived !== "boolean")
    throw new Error("invalid_memory_archived");
  if (value.includeSuperseded !== undefined && typeof value.includeSuperseded !== "boolean")
    throw new Error("invalid_memory_includeSuperseded");
  if (value.includeConflicts !== undefined && typeof value.includeConflicts !== "boolean")
    throw new Error("invalid_memory_includeConflicts");
  if (
    value.includeWorkspace !== undefined &&
    (typeof value.includeWorkspace !== "boolean" || !project.projectId)
  )
    throw new Error("invalid_memory_includeWorkspace");
  if (operation === "search")
    return {
      ...(value.archived === undefined ? {} : { archived: value.archived }),
      ...(value.includeSuperseded === undefined
        ? {}
        : { includeSuperseded: value.includeSuperseded }),
      ...(value.includeWorkspace === undefined ? {} : { includeWorkspace: value.includeWorkspace }),
      ...(value.includeConflicts === undefined ? {} : { includeConflicts: value.includeConflicts }),
      operation,
      query: string("query", 500),
      offset: number("offset", 0),
      ...project,
    };
  if (operation === "list") {
    if (value.archived !== undefined && typeof value.archived !== "boolean")
      throw new Error("invalid_memory_archived");
    return {
      operation,
      offset: number("offset", 0),
      archived: value.archived === true,
      ...(project.projectId ? { projectId: project.projectId } : {}),
    };
  }
  if (operation === "get") {
    const revision = value.revision === undefined ? undefined : number("revision");
    if (revision === 0) throw new Error("invalid_memory_revision");
    return { operation, id: uuid("id"), ...(revision === undefined ? {} : { revision }) };
  }
  if (operation === "history") return { operation, id: uuid("id"), offset: number("offset", 0) };
  let draft: TeamMemoryDraft | undefined;
  if (hasDraft) {
    const kind = string("kind", 20);
    if (!MEMORY_KINDS.includes(kind as MemoryKind)) throw new Error("invalid_memory_kind");
    if (value.pinned !== undefined && typeof value.pinned !== "boolean")
      throw new Error("invalid_memory_pinned");
    draft = {
      ...project,
      ...(value.pinned === undefined ? {} : { pinned: value.pinned }),
      title: string("title", 200),
      content: string("content", 16_000),
      source: string("source"),
      applicability: string("applicability", 300, true),
      kind: kind as MemoryKind,
      ...(value.evidence === undefined
        ? {}
        : { evidence: decodeReferences(value.evidence, evidenceKinds, "evidence") }),
      ...(value.relations === undefined
        ? {}
        : {
            relations: decodeReferences(
              value.relations,
              relationKinds,
              "relations",
            ) as TeamMemoryRelation[],
          }),
      ...(value.effectiveAt === undefined
        ? {}
        : { effectiveAt: decodeEffectiveAt(value.effectiveAt) }),
    };
  }
  if (operation === "prepare") return { operation, ...draft! };
  const common = {
    requestId: uuid("requestId"),
    ...(value.maintenanceToken === undefined ? {} : { maintenanceToken: uuid("maintenanceToken") }),
    ...(value.reviewToken === undefined ? {} : { reviewToken: uuid("reviewToken") }),
  };
  if (operation === "create") return { operation, ...common, ...draft! };
  const target = { id: uuid("id"), revision: number("revision"), reason: string("reason") };
  if (target.revision === 0) throw new Error("invalid_memory_revision");
  if (operation === "archive" || operation === "delete") return { operation, ...common, ...target };
  if (operation === "restore") {
    const fromRevision = number("fromRevision");
    if (!fromRevision) throw new Error("invalid_memory_fromRevision");
    return { operation, ...common, ...target, fromRevision };
  }
  if (operation === "update") return { operation, ...common, ...target, ...draft! };
  if (operation === "merge") {
    if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 10)
      throw new Error("invalid_memory_sources");
    const seen = new Set([target.id]);
    const sources = value.sources.map((item) => {
      if (
        !isRecord(item) ||
        Object.keys(item).some((key) => key !== "id" && key !== "revision") ||
        typeof item.id !== "string" ||
        !UUID.test(item.id) ||
        typeof item.revision !== "number" ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1 ||
        seen.has(item.id.toLowerCase())
      )
        throw new Error("invalid_memory_sources");
      seen.add(item.id.toLowerCase());
      return { id: item.id.toLowerCase(), revision: item.revision };
    });
    return { operation, ...common, ...target, ...draft!, sources };
  }
  throw new Error("invalid_memory_operation");
}

export function teamMemoryTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const terms = new Set(normalized.match(/[\p{L}\p{N}_.:/-]+/gu) ?? []);
  for (const term of Array.from(terms))
    if (/[\p{Script=Han}]/u.test(term))
      for (let index = 0; index < term.length - 1; index++) terms.add(term.slice(index, index + 2));
  return [...terms].slice(0, 24);
}

const uuidStringSchema = z.string().regex(UUID);
const isoDateStringSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const nullableUuidSchema = uuidStringSchema.nullable();

const teamMemoryEntryHeaderSchema = z
  .looseObject({
    id: uuidStringSchema,
    authorAgentId: nullableUuidSchema,
    authorUserId: nullableUuidSchema.optional(),
    revision: z.int().min(1),
    status: z.enum(["active", "archived"]),
    updatedAt: isoDateStringSchema,
  })
  .refine(
    (entry) =>
      (typeof entry.authorAgentId === "string" &&
        (entry.authorUserId === undefined || entry.authorUserId === null)) ||
      (entry.authorAgentId === null && typeof entry.authorUserId === "string"),
  );

const teamMemoryProjectSchema = z.looseObject({
  id: uuidStringSchema,
  name: z.string().max(100),
  slug: z.string().max(100),
  description: z.string().max(2000),
});

const teamMemoryProjectsSchema = z.array(teamMemoryProjectSchema).max(20);

const teamMemoryMaintenanceHintSchema = z.looseObject({
  projectId: nullableUuidSchema,
  observedEntries: z.int().min(0).max(65),
  observedBytes: z
    .int()
    .min(0)
    .max(8 * 1024 * 1024),
  incomplete: z.boolean(),
  nextCommand: z.string().max(200),
  guidance: z.string().max(600),
});

const teamMemoryMaintenanceSchema = z.looseObject({
  token: uuidStringSchema,
  expiresAt: isoDateStringSchema,
  remaining: z.int().min(0).max(5),
  projectId: nullableUuidSchema,
});

const teamMemoryResultEnvelopeSchema = z
  .looseObject({
    status: z.enum(["ok", "review_required", "deleted"]),
    entries: z.array(z.unknown()).max(10),
    projects: z.unknown().optional(),
    maintenanceHint: z.unknown().optional(),
    maintenance: z.unknown().optional(),
    reviewRevision: z.int().min(0).optional(),
    reviewToken: uuidStringSchema.optional(),
    nextOffset: z.int().min(0).optional(),
    replayed: z.boolean().optional(),
  })
  .refine(
    (result) =>
      result.status !== "review_required" ||
      (result.reviewRevision !== undefined && result.reviewToken !== undefined),
  );

export function decodeTeamMemoryResult(value: unknown): TeamMemoryResult {
  const envelope = teamMemoryResultEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error("invalid_memory_response");
  for (const entry of envelope.data.entries) {
    const header = teamMemoryEntryHeaderSchema.safeParse(entry);
    if (!header.success) throw new Error("invalid_memory_entry");
    decodeTeamMemoryCommand({
      operation: "prepare",
      title: header.data.title,
      content: header.data.content,
      source: header.data.source,
      kind: header.data.kind,
      applicability: header.data.applicability,
      projectId: header.data.projectId,
      pinned: header.data.pinned,
      evidence: header.data.evidence,
      relations: header.data.relations,
      effectiveAt: header.data.effectiveAt,
    });
  }
  if (
    envelope.data.projects !== undefined &&
    !teamMemoryProjectsSchema.safeParse(envelope.data.projects).success
  )
    throw new Error("invalid_memory_projects");
  if (
    envelope.data.maintenanceHint !== undefined &&
    !teamMemoryMaintenanceHintSchema.safeParse(envelope.data.maintenanceHint).success
  )
    throw new Error("invalid_memory_maintenance_hint");
  if (
    envelope.data.maintenance !== undefined &&
    !teamMemoryMaintenanceSchema.safeParse(envelope.data.maintenance).success
  )
    throw new Error("invalid_memory_maintenance");
  return envelope.data as unknown as TeamMemoryResult;
}
