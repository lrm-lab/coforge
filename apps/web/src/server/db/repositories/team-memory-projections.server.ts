import type { TeamMemoryDraft, TeamMemoryHead, TeamMemoryWrite } from "@lrm/coforge-sdk/agent";
import type { Prisma } from "#src/generated/prisma/client";
import { TeamMemoryError } from "#src/server/team-memory/memory";

export type Row = TeamMemoryDraft & {
  id: string;
  workspaceId: string;
  revision: number;
  status: string;
  authorAgentId: string;
  updatedAt: Date;
};
export type Version = {
  snapshot: Prisma.JsonValue;
  actorAgentId: string;
  operation: string;
  reason: string;
  mergedFrom: Prisma.JsonValue;
};

export function versionHead(version: Version): TeamMemoryHead {
  return {
    ...(version.snapshot as unknown as TeamMemoryHead),
    change: {
      actorAgentId: version.actorAgentId,
      operation: version.operation,
      reason: version.reason,
      mergedFrom: version.mergedFrom as { id: string; revision: number }[],
    },
  };
}

export function head(row: Row): TeamMemoryHead {
  if (row.status !== "active" && row.status !== "archived") throw new TeamMemoryError("not_found");
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    authorAgentId: row.authorAgentId,
    updatedAt: row.updatedAt.toISOString(),
    title: row.title,
    content: row.content,
    source: row.source,
    applicability: row.applicability,
    kind: row.kind,
  };
}
export function searchText(draft: TeamMemoryDraft): string {
  return `${draft.title}\n${draft.content}\n${draft.applicability}`.normalize("NFKC").toLowerCase();
}
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
export function fingerprint(command: TeamMemoryWrite): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ ...command, reviewToken: undefined }))
    .digest("hex");
}
