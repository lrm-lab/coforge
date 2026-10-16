import type { PrismaClient } from "#src/generated/prisma/client";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import {
  HostJobError,
  compareJobs,
  type CloudComputer,
  type CloudFleet,
  type ClusterJobs,
  type DaemonKeys,
  type HostJobOperation,
  type HostJobRecord,
  type WorkspaceAccess,
} from "#src/server/hosts/host-jobs.server";

export class PrismaWorkspaceMembers implements WorkspaceAccess {
  constructor(private readonly db: PrismaClient) {}

  async findMember(workspaceId: string, userId: string) {
    const workspace = await this.db.workspace.findFirst({
      where: { id: workspaceId, members: { some: { userId } } },
      select: { id: true, slug: true },
    });
    return workspace ?? undefined;
  }
}

export class PrismaCloudFleet implements CloudFleet {
  constructor(private readonly db: PrismaClient) {}

  async list(ownerId: string): Promise<CloudComputer[]> {
    const rows = await this.db.computer.findMany({
      where: { ownerId, kind: "cloud" },
      select: {
        id: true,
        ownerId: true,
        cloudSlot: true,
        homeWorkspaceId: true,
        name: true,
        displayName: true,
        deletedAt: true,
        hostJobs: {
          where: { operation: "create", containerId: { not: null }, reportedAt: { not: null } },
          select: { id: true },
          take: 1,
        },
      },
    });
    return rows.flatMap((row) => {
      if (row.cloudSlot !== "default" && row.cloudSlot !== "extra") return [];
      return [
        {
          id: row.id,
          ownerId: row.ownerId,
          slot: row.cloudSlot,
          homeWorkspaceId: row.homeWorkspaceId,
          name: row.name,
          displayName: row.displayName,
          containerReady: row.hostJobs.length > 0,
          deletedAt: row.deletedAt,
        },
      ];
    });
  }

  async insert(computer: CloudComputer): Promise<void> {
    try {
      await this.db.computer.create({
        data: {
          id: computer.id,
          ownerId: computer.ownerId,
          machineId: `cloud-${computer.id}`,
          name: computer.name,
          displayName: computer.displayName || computer.name,
          kind: "cloud",
          cloudSlot: computer.slot,
          homeWorkspaceId: computer.homeWorkspaceId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HostJobError(409, "cloud computer slot is taken");
      throw error;
    }
  }

  async markReady(): Promise<void> {
    // list() reads a reported create job. The computer row has nothing else to store.
  }

  async markDeleted(id: string, at: Date): Promise<void> {
    await this.db.computer.update({ where: { id }, data: { deletedAt: at } });
  }

  async forgetContainer(id: string): Promise<void> {
    await this.db.hostJob.updateMany({
      where: { computerId: id, operation: "create" },
      data: { containerId: null },
    });
  }

  async linkedWorkspaces(computerId: string) {
    const rows = await this.db.workspaceComputer.findMany({
      where: { computerId },
      select: { workspace: { select: { id: true, slug: true } } },
    });
    return rows.map((row) => ({ id: row.workspace.id, slug: row.workspace.slug }));
  }

  async isLinked(computerId: string, workspaceId: string): Promise<boolean> {
    const link = await this.db.workspaceComputer.findUnique({
      where: { workspaceId_computerId: { workspaceId, computerId } },
      select: { id: true },
    });
    return link !== null;
  }

  async link(computerId: string, workspaceId: string, _slug: string): Promise<void> {
    await this.db.workspaceComputer.create({ data: { workspaceId, computerId } });
  }
}

export class PrismaDaemonKeys implements DaemonKeys {
  constructor(private readonly db: PrismaClient) {}

  async issue(input: { userId: string; workspaceId: string; computerId: string }): Promise<string> {
    const prepared = prepareDaemonApiKey({
      principal: { userId: input.userId },
      workspaceId: input.workspaceId,
      computerId: input.computerId,
    });
    await this.db.daemonApiKey.create({ data: prepared.record });
    return prepared.apiKey;
  }
}

type JobRow = {
  id: string;
  hostId: string;
  operation: string;
  workspaceId: string;
  workspaceSlug: string;
  computerId: string;
  requestedByUserId: string;
  idempotencyKey: string;
  name: string;
  daemonApiKey: string | null;
  containerId: string | null;
  createdAt: Date;
  reportedAt: Date | null;
};

export class PrismaHostJobStore implements ClusterJobs {
  constructor(private readonly db: PrismaClient) {}

  async findOpenFormat(ownerId: string, computerId: string) {
    const row = await this.db.hostJob.findFirst({
      where: {
        requestedByUserId: ownerId,
        computerId,
        operation: "delete",
        reportedAt: null,
        idempotencyKey: { startsWith: "cloud-format:" },
      },
    });
    return row ? fromRow(row) : undefined;
  }

  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    const row = await this.db.hostJob.findUnique({
      where: { requestedByUserId_idempotencyKey: { requestedByUserId: ownerId, idempotencyKey } },
    });
    return row ? fromRow(row) : undefined;
  }

  async insert(record: HostJobRecord): Promise<void> {
    await this.db.hostJob.create({ data: toRow(record) });
  }

  async abandon(computerId: string, now: Date): Promise<void> {
    await this.db.hostJob.updateMany({
      where: { computerId, reportedAt: null, operation: { not: "delete" } },
      data: { reportedAt: now, daemonApiKey: null },
    });
  }

  async next(clusterId: string, accepting: boolean): Promise<HostJobRecord | undefined> {
    const rows = await this.db.hostJob.findMany({
      where: {
        hostId: clusterId,
        reportedAt: null,
        ...(accepting ? {} : { operation: { in: ["delete", "attach"] } }),
      },
    });
    return rows.map(fromRow).sort(compareJobs)[0];
  }

  async save(record: HostJobRecord): Promise<void> {
    await this.db.hostJob.update({
      where: { id: record.id },
      data: {
        containerId: record.containerId,
        reportedAt: record.reportedAt,
        daemonApiKey: record.daemonApiKey,
      },
    });
  }

  async findById(id: string): Promise<HostJobRecord | undefined> {
    const row = await this.db.hostJob.findUnique({ where: { id } });
    return row ? fromRow(row) : undefined;
  }
}

function toRow(record: HostJobRecord): JobRow {
  return {
    id: record.id,
    hostId: record.clusterId,
    operation: record.operation,
    workspaceId: record.workspaceId,
    workspaceSlug: record.workspaceSlug,
    computerId: record.computerId,
    requestedByUserId: record.ownerId,
    idempotencyKey: record.idempotencyKey,
    name: record.name,
    daemonApiKey: record.daemonApiKey,
    containerId: record.containerId,
    createdAt: record.createdAt,
    reportedAt: record.reportedAt,
  };
}

function fromRow(row: JobRow): HostJobRecord {
  return {
    id: row.id,
    clusterId: row.hostId,
    operation: operation(row.operation),
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    computerId: row.computerId,
    ownerId: row.requestedByUserId,
    idempotencyKey: row.idempotencyKey,
    name: row.name,
    daemonApiKey: row.daemonApiKey,
    containerId: row.containerId,
    createdAt: row.createdAt,
    reportedAt: row.reportedAt,
  };
}

function operation(value: string): HostJobOperation {
  if (value === "create" || value === "delete" || value === "attach") return value;
  throw new HostJobError(422, "invalid host job");
}
