import {
  COMPUTER_LIST_PROTOCOL_MAJOR,
  type ComputerCandidate,
  type ComputerListRequest,
  type ComputerListResponse,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AuthenticatedPrincipal } from "./registration.server";

export interface ComputerRosterRepository {
  listOwned(principal: AuthenticatedPrincipal): Promise<ComputerCandidate[]>;
}

export class ComputerRoster {
  constructor(private readonly repository: ComputerRosterRepository) {}

  async list(
    request: ComputerListRequest,
    principal: AuthenticatedPrincipal | undefined,
  ): Promise<ComputerListResponse> {
    if (!principal?.userId) throw new ComputerRosterError(401, "authentication required");
    if (request.protocolMajor !== COMPUTER_LIST_PROTOCOL_MAJOR || !request.requestId)
      throw new ComputerRosterError(422, "invalid computer list request");
    return {
      protocolMajor: COMPUTER_LIST_PROTOCOL_MAJOR,
      requestId: request.requestId,
      computers: await this.repository.listOwned(principal),
    };
  }
}

export class ComputerRosterError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class PrismaComputerRosterRepository implements ComputerRosterRepository {
  constructor(private readonly db: PrismaClient) {}

  async listOwned(principal: AuthenticatedPrincipal): Promise<ComputerCandidate[]> {
    const rows = await this.db.computer.findMany({
      where: {
        ownerId: principal.userId,
        kind: "local",
        deletedAt: null,
      },
      select: {
        id: true,
        machineId: true,
        name: true,
        displayName: true,
        platform: true,
        osVersion: true,
        computerVersion: true,
        metadataStartedAt: true,
        workspaces: { select: { workspace: { select: { slug: true } } } },
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      computerId: row.id,
      machineId: row.machineId,
      name: row.name,
      displayName: row.displayName,
      platform: row.platform ?? "",
      osVersion: row.osVersion ?? "",
      computerVersion: row.computerVersion ?? "",
      workspaceSlugs: row.workspaces.map(({ workspace }) => workspace.slug).sort(),
      ...(row.metadataStartedAt !== null
        ? { lastSeenAt: new Date(Number(row.metadataStartedAt)).toISOString() }
        : {}),
    }));
  }
}
