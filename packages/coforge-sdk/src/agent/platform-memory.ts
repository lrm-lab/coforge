export type MemoryScope = "agent" | "team";
export type MemoryKind = "fact" | "experience" | "preference";
export type MemoryWrite = {
  title: string;
  content: string;
  kind: MemoryKind;
  sourceMessageId?: string;
  expiresAt?: string;
};
export type PlatformMemoryCommand =
  | { operation: "status" }
  | { operation: "list"; scope?: MemoryScope; agentId?: string; page?: number }
  | { operation: "search"; query: string; scope?: MemoryScope; agentId?: string }
  | { operation: "get"; id: string }
  | ({ operation: "create"; scope: MemoryScope; agentId?: string; requestId: string } & MemoryWrite)
  | ({ operation: "update"; id: string; revision: number; requestId: string } & MemoryWrite)
  | { operation: "delete"; id: string; revision: number; requestId: string }
  | { operation: "share"; id: string; revision: number; requestId: string };

export type PlatformMemoryEntry = MemoryWrite & {
  id: string;
  scope: MemoryScope;
  agentId: string | null;
  revision: number;
  canEdit?: boolean;
  createdAt: string;
  updatedAt: string;
};
export type PlatformMemoryResult = {
  enabled: boolean;
  available: boolean;
  entries: PlatformMemoryEntry[];
  page?: number;
  pageCount?: number;
  deleted?: boolean;
  cleanupPending?: boolean;
};

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("invalid memory text");
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("invalid memory id");
  return value.toLowerCase();
}
export function decodePlatformMemoryCommand(value: unknown): PlatformMemoryCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid memory command");
  const row = value as Record<string, unknown>;
  const operation = row.operation;
  if (operation === "status") return { operation };
  if (operation === "get") return { operation, id: id(row.id) };
  const scope = row.scope;
  if (scope !== undefined && scope !== "agent" && scope !== "team")
    throw new Error("invalid memory scope");
  const selection: { scope?: MemoryScope; agentId?: string } = {
    ...(scope ? { scope } : {}),
    ...(row.agentId === undefined ? {} : { agentId: id(row.agentId) }),
  };
  if (operation === "list") {
    const page = row.page ?? 1;
    if (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10000)
      throw new Error("invalid memory page");
    return { operation, ...selection, page: Number(page) };
  }
  if (operation === "search") return { operation, ...selection, query: text(row.query, 2000) };
  const requestId = id(row.requestId);
  const revision = row.revision;
  if (operation !== "create" && (!Number.isSafeInteger(revision) || Number(revision) < 1))
    throw new Error("invalid memory revision");
  if (operation === "delete" || operation === "share")
    return { operation, id: id(row.id), revision: Number(revision), requestId };
  if (operation !== "create" && operation !== "update") throw new Error("invalid memory operation");
  if (!["fact", "experience", "preference"].includes(String(row.kind)))
    throw new Error("invalid memory kind");
  const write: MemoryWrite = {
    title: text(row.title, 160),
    content: text(row.content, 16000),
    kind: row.kind as MemoryKind,
    ...(row.sourceMessageId === undefined ? {} : { sourceMessageId: id(row.sourceMessageId) }),
  };
  if (row.expiresAt !== undefined) {
    if (typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt)))
      throw new Error("invalid memory expiry");
    write.expiresAt = new Date(row.expiresAt).toISOString();
  }
  if (operation === "create") {
    if (!scope) throw new Error("memory scope is required");
    return {
      operation,
      scope,
      ...(selection.agentId ? { agentId: selection.agentId } : {}),
      requestId,
      ...write,
    };
  }
  return { operation, id: id(row.id), revision: Number(revision), requestId, ...write };
}
