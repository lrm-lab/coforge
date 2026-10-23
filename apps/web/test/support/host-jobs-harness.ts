import {
  compareJobs,
  HostJobError,
  HostJobs,
  type CloudComputer,
  type ClusterJobs,
  type HostJobRecord,
} from "#src/server/hosts/host-jobs.server";

export const now = new Date("2026-09-30T06:00:00.000Z");
export const daemonKey = `dk_${"b".repeat(43)}`;
export const ownerDisplayName = "Ada Lovelace";
export const defaultCloudName = `${ownerDisplayName}的默认云电脑`;
export const extraCloudName = `${ownerDisplayName}的新建云电脑`;
export const accounts = {
  displayName: async (userId: string) => (userId === "user-a" ? ownerDisplayName : undefined),
};

export function hostsFor(
  fleet: MemoryFleet,
  jobs: MemoryJobs,
  findMember: (
    workspaceId: string,
    userId: string,
  ) => Promise<{ id: string; slug: string } | undefined> = async (workspaceId) =>
    workspaceId === "workspace-2" ? { id: workspaceId, slug: "beta" } : undefined,
) {
  return new HostJobs({
    workspaces: { findMember },
    fleet,
    jobs,
    cluster: {
      id: async () => "cluster-1",
      authenticate: async () => ({ id: "cluster-1", accepting: true }),
    },
    keys: { issue: async () => daemonKey },
    accounts,
  });
}

export class MemoryFleet {
  computers: CloudComputer[] = [];
  links: Array<{ computerId: string; workspaceId: string; slug: string }> = [];
  async list(ownerId: string) {
    return this.computers.filter((computer) => computer.ownerId === ownerId);
  }
  async insert(computer: CloudComputer) {
    const clash = this.computers.some(
      (item) =>
        item.ownerId === computer.ownerId &&
        item.deletedAt === null &&
        item.slot === computer.slot &&
        (computer.slot === "default" || item.homeWorkspaceId === computer.homeWorkspaceId),
    );
    if (clash) throw new HostJobError(409, "cloud computer slot is taken");
    this.computers.push({ ...computer });
  }
  async markReady(id: string) {
    const computer = this.computers.find((item) => item.id === id);
    if (computer) computer.containerReady = true;
  }
  async markDeleted(id: string, at: Date) {
    const computer = this.computers.find((item) => item.id === id);
    if (computer) computer.deletedAt = at;
  }
  async forgetContainer(id: string) {
    const computer = this.computers.find((item) => item.id === id);
    if (computer) computer.containerReady = false;
  }
  async linkedWorkspaces(computerId: string) {
    return this.links
      .filter((link) => link.computerId === computerId)
      .map((link) => ({ id: link.workspaceId, slug: link.slug }));
  }
  async isLinked(computerId: string, workspaceId: string) {
    return this.links.some(
      (link) => link.computerId === computerId && link.workspaceId === workspaceId,
    );
  }
  async link(computerId: string, workspaceId: string, slug: string) {
    this.links.push({ computerId, workspaceId, slug });
  }
}

export class MemoryJobs implements ClusterJobs {
  readonly records: HostJobRecord[] = [];
  async findLatestCreate(computerId: string) {
    return [...this.records]
      .reverse()
      .find((job) => job.computerId === computerId && job.operation === "create");
  }
  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    return this.records.find(
      (job) => job.ownerId === ownerId && job.idempotencyKey === idempotencyKey,
    );
  }
  async findOpenFormat(ownerId: string, computerId: string) {
    return this.records.find(
      (job) =>
        job.ownerId === ownerId &&
        job.computerId === computerId &&
        job.operation === "delete" &&
        job.reportedAt === null &&
        job.idempotencyKey.startsWith("cloud-format:"),
    );
  }
  async insert(record: HostJobRecord) {
    this.records.push({ ...record });
  }
  async abandon(computerId: string, at: Date) {
    for (const job of this.records) {
      if (job.computerId === computerId && job.reportedAt === null && job.operation !== "delete") {
        job.reportedAt = at;
        job.daemonApiKey = null;
      }
    }
  }
  async next(clusterId: string, accepting: boolean, updatesPaused = false) {
    return this.records
      .filter(
        (job) =>
          job.clusterId === clusterId &&
          job.reportedAt === null &&
          (!updatesPaused || job.operation !== "update") &&
          (accepting || (job.operation !== "create" && job.operation !== "update")),
      )
      .sort(compareJobs)[0];
  }
  async save(record: HostJobRecord) {
    const index = this.records.findIndex((job) => job.id === record.id);
    this.records[index] = { ...record };
  }
  async findById(id: string) {
    return this.records.find((job) => job.id === id);
  }
}

export function harness(input?: {
  imageUpdatesPaused?: () => boolean;
  imageUpdatePolicy?: (computerId: string) => Promise<"allow" | "retain" | "unknown" | "paused">;
  member?: boolean;
  accepting?: boolean;
  clearDisk?: (computerId: string) => Promise<void>;
  accounts?: { displayName(userId: string): Promise<string | undefined> };
}) {
  const fleet = new MemoryFleet();
  const jobs = new MemoryJobs();
  const issued: string[] = [];
  let accepting = input?.accepting !== false;
  const hosts = new HostJobs({
    workspaces: {
      findMember: async (workspaceId, userId) =>
        input?.member === false || workspaceId !== "workspace-1" || userId !== "user-a"
          ? undefined
          : { id: workspaceId, slug: "alpha" },
    },
    fleet,
    jobs,
    cluster: {
      id: async () => "cluster-1",
      authenticate: async (token) =>
        token === "host-token" ? { id: "cluster-1", accepting } : undefined,
    },
    keys: {
      issue: async () => {
        issued.push(daemonKey);
        return daemonKey;
      },
    },
    accounts: input?.accounts ?? accounts,
    imageUpdatesPaused: input?.imageUpdatesPaused,
    imageUpdatePolicy: input?.imageUpdatePolicy,
    ...(input?.clearDisk ? { disk: { clear: input.clearDisk } } : {}),
  });
  return {
    hosts,
    fleet,
    jobs,
    issued,
    setAccepting(value: boolean) {
      accepting = value;
    },
  };
}

export const request = { userId: "user-a", workspaceId: "workspace-1", now };
