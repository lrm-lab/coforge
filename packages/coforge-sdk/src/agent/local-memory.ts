import { z } from "zod";
import { isRecord } from "#src/internal/json-record";

export const LOCAL_MEMORY_ROUTE = { method: "POST", path: "/api/agent/v1/local-memory" } as const;
export const MEMORY_KINDS = ["fact", "decision", "preference", "experience"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type LocalMemoryCommand =
  | { operation: "search"; query: string; offset?: number; archived?: boolean }
  | { operation: "list"; offset?: number; archived?: boolean }
  | { operation: "get"; key: string; revision?: string }
  | { operation: "history"; key: string; offset?: number }
  | { operation: "archive"; key: string; revision: string }
  | {
      operation: "save";
      key: string;
      revision: string;
      title: string;
      content: string;
      source: string;
      kind: MemoryKind;
      applicability: string;
    };
export type LocalMemoryEntry = {
  key: string;
  title: string;
  content: string;
  source: string;
  kind: MemoryKind;
  applicability: string;
  status: "active" | "archived";
  updatedAt: string;
  revision: string;
  path: string;
};
export type LocalMemoryResult = {
  entries: LocalMemoryEntry[];
  nextOffset?: number;
  incomplete?: boolean;
};

const localMemoryEntrySchema = z.looseObject({
  key: z.string(),
  title: z.string(),
  content: z.string(),
  source: z.string(),
  kind: z.enum(MEMORY_KINDS),
  applicability: z.string(),
  status: z.enum(["active", "archived"]),
  updatedAt: z.string(),
  revision: z.string(),
  path: z.string(),
});

const localMemoryResultEnvelopeSchema = z.object({
  entries: z.array(z.unknown()).max(100),
  nextOffset: z.int().min(0).optional(),
  incomplete: z.boolean().optional(),
});

export function decodeLocalMemoryResult(value: unknown): LocalMemoryResult {
  const envelope = localMemoryResultEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error("invalid_memory_result");
  const entries = envelope.data.entries.map((entry) => {
    const parsed = localMemoryEntrySchema.safeParse(entry);
    if (!parsed.success) throw new Error("invalid_memory_entry");
    return parsed.data;
  });
  return {
    entries,
    ...(envelope.data.nextOffset === undefined ? {} : { nextOffset: envelope.data.nextOffset }),
    ...(envelope.data.incomplete === undefined ? {} : { incomplete: envelope.data.incomplete }),
  };
}

export function decodeLocalMemoryCommand(value: unknown): LocalMemoryCommand {
  if (!isRecord(value)) throw new Error("invalid_memory_command");
  const text = (name: string, max: number, empty = false): string => {
    const item = value[name];
    if (
      typeof item !== "string" ||
      (!empty && !item.trim()) ||
      item.length > max ||
      item.includes("\0")
    )
      throw new Error(`invalid_memory_${name}`);
    return item;
  };
  const operation = text("operation", 20);
  const fields =
    operation === "list"
      ? ["offset", "archived"]
      : operation === "search"
        ? ["query", "offset", "archived"]
        : operation === "save"
          ? ["key", "revision", "title", "content", "source", "kind", "applicability"]
          : operation === "archive"
            ? ["key", "revision"]
            : operation === "get"
              ? ["key", "revision"]
              : ["key", "offset"];
  if (Object.keys(value).some((key) => key !== "operation" && !fields.includes(key)))
    throw new Error("invalid_memory_field");
  if (operation === "search" || operation === "list") {
    const offset = value.offset;
    if (
      offset !== undefined &&
      (typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > (operation === "search" ? 10_000_000 : 100_000))
    )
      throw new Error("invalid_memory_offset");
    const pagination = offset === undefined ? {} : { offset };
    if (value.archived !== undefined && typeof value.archived !== "boolean")
      throw new Error("invalid_memory_archived");
    if (operation === "search")
      return {
        operation,
        query: text("query", 500),
        ...pagination,
        ...(value.archived === undefined ? {} : { archived: value.archived }),
      };
    if (value.archived !== undefined && typeof value.archived !== "boolean")
      throw new Error("invalid_memory_archived");
    return {
      operation,
      ...pagination,
      ...(value.archived === undefined ? {} : { archived: value.archived }),
    };
  }
  const key = text("key", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) throw new Error("invalid_memory_key");
  if (operation === "history") {
    const offset = value.offset ?? 0;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000
    )
      throw new Error("invalid_memory_offset");
    return { operation, key, offset };
  }
  if (operation === "get") {
    if (value.revision === undefined) return { operation, key };
    const revision = text("revision", 64);
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("invalid_memory_revision");
    return { operation, key, revision };
  }
  const revision = text("revision", 64);
  if (revision !== "new" && !/^[a-f0-9]{64}$/.test(revision))
    throw new Error("invalid_memory_revision");
  if (operation === "archive") return { operation, key, revision };
  if (operation !== "save") throw new Error("invalid_memory_operation");
  const kind = text("kind", 20);
  if (!MEMORY_KINDS.some((item) => item === kind)) throw new Error("invalid_memory_kind");
  return {
    operation,
    key,
    revision,
    title: text("title", 200),
    content: text("content", 16_000),
    source: text("source", 1_000),
    kind: kind as MemoryKind,
    applicability: text("applicability", 300, true),
  };
}
