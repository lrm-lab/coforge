import {
  decodeTeamMemoryCommand,
  type TeamMemoryCommand,
  type TeamMemoryCatalogCommand,
  type TeamMemoryDraft,
  type TeamMemoryHead,
  type TeamMemoryResult,
  type TeamMemoryWrite,
} from "@lrm/coforge-sdk/agent";

export type TeamMemoryActor = { workspaceId: string } & (
  | { agentId: string; userId?: never }
  | { userId: string; agentId?: never }
);
export interface TeamMemoryStore {
  catalog?(actor: TeamMemoryActor, command: TeamMemoryCatalogCommand): Promise<TeamMemoryResult>;
  read(
    actor: TeamMemoryActor,
    command: Exclude<TeamMemoryCommand, TeamMemoryWrite | TeamMemoryCatalogCommand>,
  ): Promise<TeamMemoryResult>;
  review(actor: TeamMemoryActor, command: TeamMemoryWrite): Promise<TeamMemoryResult>;
  write(actor: TeamMemoryActor, command: TeamMemoryWrite): Promise<TeamMemoryResult>;
}
export class TeamMemoryError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "conflict" | "invalid" | "disabled") {
    super(`memory_${code}`);
  }
}

export class TeamMemory {
  constructor(private readonly store: TeamMemoryStore) {}
  execute(actor: TeamMemoryActor, input: TeamMemoryCommand): Promise<TeamMemoryResult> {
    const command = decodeTeamMemoryCommand(input);
    if (command.operation === "projects" || command.operation === "project-create") {
      if (!this.store.catalog) throw new TeamMemoryError("invalid");
      return this.store.catalog(actor, command);
    }
    if (!("requestId" in command)) return this.store.read(actor, command);
    if (command.reviewToken === undefined) return this.store.review(actor, command);
    return this.store.write(actor, command);
  }
}

export function teamMemoryDedup(draft: TeamMemoryDraft): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        draft.title.trim().normalize("NFKC"),
        draft.content.trim().normalize("NFKC"),
        draft.applicability.trim().normalize("NFKC"),
        draft.kind,
        ...(draft.projectId ? [draft.projectId] : []),
      ]),
    )
    .digest("hex");
}

export function validateTeamMutation(
  actor: TeamMemoryActor,
  command: TeamMemoryWrite,
  target: TeamMemoryHead | undefined,
  sources: TeamMemoryHead[],
  admin: boolean,
): void {
  if (command.operation === "create") {
    if (target && target.status !== "active") throw new TeamMemoryError("conflict");
    return;
  }
  if (!target) throw new TeamMemoryError("not_found");
  if (target.revision !== command.revision) throw new TeamMemoryError("conflict");
  if (
    command.operation === "delete" &&
    !(actor.agentId && target.authorAgentId === actor.agentId) &&
    !(actor.userId && target.authorUserId === actor.userId) &&
    !admin
  )
    throw new TeamMemoryError("forbidden");
  if (command.operation === "merge") {
    if (sources.length !== command.sources.length || target.status !== "active")
      throw new TeamMemoryError("conflict");
    for (const reference of command.sources) {
      const source = sources.find((entry) => entry.id === reference.id);
      if (
        !source ||
        source.revision !== reference.revision ||
        source.status !== "active" ||
        source.applicability !== target.applicability ||
        (source.projectId ?? null) !== (target.projectId ?? null) ||
        (command.projectId !== undefined && command.projectId !== (target.projectId ?? null)) ||
        source.applicability !== command.applicability
      )
        throw new TeamMemoryError("conflict");
    }
  }
}
