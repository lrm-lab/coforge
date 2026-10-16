import { describe, expect, test } from "bun:test";

import {
  compareJobs,
  HostJobError,
  HostJobs,
  type CloudComputer,
  type ClusterJobs,
  type HostJobRecord,
} from "#src/server/hosts/host-jobs.server";
import { createHostJobHttpHandler } from "#src/server/hosts/host-job-http.server";

const now = new Date("2026-09-30T06:00:00.000Z");
const daemonKey = `dk_${"b".repeat(43)}`;

class MemoryFleet {
  computers: CloudComputer[] = [];
  links: Array<{ computerId: string; workspaceId: string }> = [];
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
  async isLinked(computerId: string, workspaceId: string) {
    return this.links.some(
      (link) => link.computerId === computerId && link.workspaceId === workspaceId,
    );
  }
  async link(computerId: string, workspaceId: string) {
    this.links.push({ computerId, workspaceId });
  }
}

class MemoryJobs implements ClusterJobs {
  readonly records: HostJobRecord[] = [];
  async findByIdempotency(ownerId: string, idempotencyKey: string) {
    return this.records.find(
      (job) => job.ownerId === ownerId && job.idempotencyKey === idempotencyKey,
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
  async next(clusterId: string, accepting: boolean) {
    return this.records
      .filter(
        (job) =>
          job.clusterId === clusterId &&
          job.reportedAt === null &&
          (accepting || job.operation !== "create"),
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

function harness(input?: { member?: boolean; accepting?: boolean }) {
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

const request = { userId: "user-a", workspaceId: "workspace-1", now };

describe("cloud computer quota", () => {
  test("the first request creates the default computer and the cluster claims its daemon key", async () => {
    const { hosts, jobs, issued } = harness();
    const created = await hosts.ensureDefault(request);

    expect(created).toMatchObject({
      slot: "default",
      name: "Cloud",
      containerReady: false,
    });
    expect(JSON.stringify(created)).not.toContain(daemonKey);
    expect(issued).toEqual([daemonKey]);
    expect(jobs.records[0]?.daemonApiKey).toBe(daemonKey);

    const again = await hosts.ensureDefault(request);
    expect(again.computerId).toBe(created.computerId);
    expect(jobs.records).toHaveLength(1);

    const claimed = await hosts.claim({ token: "host-token" });
    expect(claimed).toMatchObject({
      operation: "create",
      computerId: created.computerId,
      workspaceSlug: "alpha",
      daemonApiKey: daemonKey,
    });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    expect(jobs.records[0]?.daemonApiKey).toBeNull();
    expect((await hosts.ensureDefault(request)).containerReady).toBe(true);
    expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
  });

  test("a second workspace attaches the same default computer", async () => {
    const { hosts, fleet, jobs } = harness();
    const created = await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });

    const hostsWithBeta = new HostJobs({
      workspaces: {
        findMember: async (workspaceId) =>
          workspaceId === "workspace-2" ? { id: workspaceId, slug: "beta" } : undefined,
      },
      fleet,
      jobs,
      cluster: {
        id: async () => "cluster-1",
        authenticate: async () => ({ id: "cluster-1", accepting: true }),
      },
      keys: { issue: async () => daemonKey },
    });
    const attached = await hostsWithBeta.ensureDefault({
      userId: "user-a",
      workspaceId: "workspace-2",
      now,
    });
    expect(attached.computerId).toBe(created.computerId);
    expect(fleet.computers).toHaveLength(1);
    expect(jobs.records.map((job) => job.operation)).toEqual(["create", "attach"]);
    const attach = await hosts.claim({ token: "host-token" });
    expect(attach?.operation).toBe("attach");
    expect(attach?.workspaceSlug).toBe("beta");
  });

  test("one extra computer is allowed only after the default container exists, and a second extra is refused", async () => {
    const { hosts } = harness();
    await hosts.ensureDefault(request);
    await expect(hosts.addExtra(request)).rejects.toEqual(
      new HostJobError(409, "default cloud computer is not ready"),
    );
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });

    const extra = await hosts.addExtra(request);
    expect(extra.slot).toBe("extra");
    await expect(hosts.addExtra(request)).rejects.toEqual(
      new HostJobError(409, "an extra cloud computer already exists"),
    );
  });

  test("another workspace can add its own extra computer", async () => {
    const { hosts, fleet, jobs } = harness();
    await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    const first = await hosts.addExtra(request);

    const hostsWithBeta = new HostJobs({
      workspaces: {
        findMember: async (workspaceId) =>
          workspaceId === "workspace-2" ? { id: workspaceId, slug: "beta" } : undefined,
      },
      fleet,
      jobs,
      cluster: {
        id: async () => "cluster-1",
        authenticate: async () => ({ id: "cluster-1", accepting: true }),
      },
      keys: { issue: async () => daemonKey },
    });
    const second = await hostsWithBeta.addExtra({
      userId: "user-a",
      workspaceId: "workspace-2",
      now,
    });

    expect(second.slot).toBe("extra");
    expect(second.computerId).not.toBe(first.computerId);
    expect(fleet.computers.filter((computer) => computer.slot === "extra")).toHaveLength(2);
    await expect(
      hostsWithBeta.addExtra({ userId: "user-a", workspaceId: "workspace-2", now }),
    ).rejects.toEqual(new HostJobError(409, "an extra cloud computer already exists"));
  });

  test("the default computer cannot be deleted, and the extra slot frees only after the cluster reports removal", async () => {
    const { hosts, fleet } = harness();
    const created = await hosts.ensureDefault(request);
    await expect(hosts.deleteExtra({ ...request, computerId: created.computerId })).rejects.toEqual(
      new HostJobError(409, "the default cloud computer cannot be deleted"),
    );

    const claimed = await hosts.claim({ token: "host-token" });
    await hosts.report({
      token: "host-token",
      jobId: claimed!.jobId,
      containerId: "service-1",
      now,
    });
    const extra = await hosts.addExtra(request);
    const removal = await hosts.deleteExtra({ ...request, computerId: extra.computerId });
    await expect(hosts.addExtra(request)).rejects.toEqual(
      new HostJobError(409, "an extra cloud computer already exists"),
    );

    const job = await hosts.claim({ token: "host-token" });
    expect(job).toMatchObject({ operation: "delete", jobId: removal.jobId, daemonApiKey: null });
    await hosts.report({ token: "host-token", jobId: job!.jobId, now });
    expect(fleet.computers.find((computer) => computer.id === extra.computerId)?.deletedAt).toEqual(
      now,
    );
    expect((await hosts.addExtra(request)).slot).toBe("extra");
  });

  test("a create stays queued while the cluster is not accepting placements", async () => {
    const { hosts, setAccepting } = harness();
    await hosts.ensureDefault(request);
    setAccepting(false);
    expect(await hosts.claim({ token: "host-token" })).toBeUndefined();
    setAccepting(true);
    expect((await hosts.claim({ token: "host-token" }))?.operation).toBe("create");
  });

  test("someone outside the workspace cannot create a cloud computer", async () => {
    const { hosts, fleet } = harness({ member: false });
    await expect(hosts.ensureDefault(request)).rejects.toEqual(
      new HostJobError(403, "workspace access denied"),
    );
    expect(fleet.computers).toEqual([]);
  });

  test("another cluster token cannot report the job", async () => {
    const { hosts } = harness();
    await hosts.ensureDefault(request);
    const claimed = await hosts.claim({ token: "host-token" });
    await expect(
      hosts.report({
        token: "other-token",
        jobId: claimed!.jobId,
        containerId: "service-1",
        now,
      }),
    ).rejects.toEqual(new HostJobError(401, "invalid host token"));
  });
});

describe("host job HTTP", () => {
  test("a user session cannot claim, and a cluster token can", async () => {
    const { hosts } = harness();
    await hosts.ensureDefault(request);
    const http = createHostJobHttpHandler({
      jobs: hosts,
      now: () => now,
    });
    const claimAsUser = await http.claim(
      new Request("https://server.example/api/hosts/jobs/claim", {
        method: "POST",
        headers: { cookie: "session=user-a" },
      }),
    );
    expect(claimAsUser.status).toBe(401);

    const claimAsHost = await http.claim(
      new Request("https://server.example/api/hosts/jobs/claim", {
        method: "POST",
        headers: { authorization: "Bearer host-token" },
      }),
    );
    const body = await claimAsHost.json();
    expect(body.job.daemonApiKey).toBe(daemonKey);
    expect(body.job.operation).toBe("create");
  });
});
