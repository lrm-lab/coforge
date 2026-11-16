import type { MemoryKind, MemoryScope, MemoryWrite } from "@lrm/coforge-sdk/agent";

export type MemoryActor = { workspaceId: string } & (
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string }
);
export type MemoryHead = {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  agentId: string | null;
  author: string;
  dedupKey: string;
  title: string;
  kind: MemoryKind;
  uri: string | null;
  revision: number;
  sourceMessageId: string | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type MemoryReceipt = { fingerprint: string; entryId: string; deleted: boolean };
export type MemoryAccess = {
  enabled: boolean;
  admin: boolean;
  agentIds: string[];
};
export interface MemoryStore {
  access(actor: MemoryActor): Promise<MemoryAccess>;
  get(workspaceId: string, id: string): Promise<MemoryHead | null>;
  receipt(workspaceId: string, actor: string, requestId: string): Promise<MemoryReceipt | null>;
  reserve(
    input: Omit<MemoryHead, "id" | "createdAt" | "updatedAt">,
    requestId: string,
    fingerprint: string,
    dedupKeys: string[],
  ): Promise<MemoryHead>;
  commit(input: {
    head: MemoryHead;
    expectedRevision: number;
    requestId: string;
    actor: string;
    fingerprint: string;
    deleted: boolean;
    dedupKeys: string[];
  }): Promise<boolean>;
  list(input: {
    workspaceId: string;
    agentIds: string[];
    scope?: MemoryScope;
    page: number;
    now: Date;
  }): Promise<{ entries: MemoryHead[]; pageCount: number }>;
  current(
    workspaceId: string,
    uris: string[],
    agentIds: string[],
    now: Date,
  ): Promise<MemoryHead[]>;
  searchUris(
    workspaceId: string,
    agentIds: string[],
    scope: MemoryScope | undefined,
    now: Date,
  ): Promise<string[]>;
  sourceAllowed(actor: MemoryActor, messageId: string): Promise<boolean>;
}
export interface MemoryEngine {
  available(workspaceId: string): Promise<boolean>;
  write(workspaceId: string, uri: string, content: MemoryWrite): Promise<void>;
  read(workspaceId: string, uri: string): Promise<MemoryWrite>;
  remove(workspaceId: string, uri: string): Promise<void>;
  search(
    workspaceId: string,
    roots: string[],
    query: string,
    currentUris: string[],
  ): Promise<string[]>;
}
export class MemoryError extends Error {
  constructor(
    readonly code: "disabled" | "unavailable" | "forbidden" | "not_found" | "conflict" | "invalid",
  ) {
    super(`memory_${code}`);
  }
}
export function actorKey(actor: MemoryActor): string {
  return actor.kind === "agent" ? `agent:${actor.agentId}` : `user:${actor.userId}`;
}
export function memoryRoot(workspaceId: string, agentId: string | null): string {
  return agentId
    ? `viking://user/coforge-agent-${agentId}/resources/coforge-${workspaceId}`
    : `viking://resources/coforge-memory/${workspaceId}/team`;
}
