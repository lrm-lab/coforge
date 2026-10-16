import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaHostStore } from "#src/server/db/repositories/host-directory.repositories.server";
import {
  PrismaCloudFleet,
  PrismaDaemonKeys,
  PrismaHostJobStore,
  PrismaWorkspaceMembers,
} from "#src/server/db/repositories/host-job.repositories.server";
import { HostDirectory } from "./host-directory.server";
import { createHostHttpHandler } from "./host-http.server";
import { createHostJobHttpHandler } from "./host-job-http.server";
import { HostJobs } from "./host-jobs.server";
import { Prisma, type PrismaClient } from "#src/generated/prisma/client";

export function clusterToken(): string | undefined {
  return process.env.COFORGE_CLOUD_CLUSTER_TOKEN;
}

export function productionHostDirectory(db: PrismaClient = requireDatabaseClient()) {
  return new HostDirectory(new PrismaHostStore(db), clusterToken());
}

export function productionHostHttp() {
  return createHostHttpHandler({
    directory: productionHostDirectory(),
    now: () => new Date(),
  });
}

export function productionCloudComputers(db: PrismaClient = requireDatabaseClient()) {
  const directory = productionHostDirectory(db);
  return new HostJobs({
    workspaces: new PrismaWorkspaceMembers(db),
    fleet: new PrismaCloudFleet(db),
    jobs: new PrismaHostJobStore(db),
    cluster: directory,
    keys: new PrismaDaemonKeys(db),
    disk: {
      clear: async (computerId) => {
        await db.agentSession.deleteMany({ where: { computerId } });
        await db.agent.updateMany({
          where: { computerId },
          data: { runtimeSession: Prisma.DbNull },
        });
      },
    },
  });
}

export function productionHostJobs() {
  const db = requireDatabaseClient();
  return createHostJobHttpHandler({
    jobs: productionCloudComputers(db),
    now: () => new Date(),
  });
}
