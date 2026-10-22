import { describe, expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  cloudImageUpdateError,
  HostJobError,
  HostJobs,
  type CloudComputer,
  type HostJobRecord,
} from "#src/server/hosts/host-jobs.server";

const now = new Date("2026-10-22T12:00:00.000Z");

function hosts() {
  const computers: CloudComputer[] = [];
  const records: HostJobRecord[] = [];
  const jobs = new HostJobs({
    workspaces: {
      findMember: async (workspaceId, userId) =>
        workspaceId === "workspace-1" && userId === "user-a"
          ? { id: workspaceId, slug: "alpha" }
          : undefined,
    },
    fleet: {
      list: async (ownerId) => computers.filter((computer) => computer.ownerId === ownerId),
      insert: async (computer) => {
        computers.push({ ...computer });
      },
      markReady: async () => undefined,
      markDeleted: async () => undefined,
      forgetContainer: async () => undefined,
      linkedWorkspaces: async () => [],
      isLinked: async () => false,
      link: async () => undefined,
    },
    jobs: {
      findLatestCreate: async () => undefined,
      findByIdempotency: async (ownerId, idempotencyKey) =>
        records.find((job) => job.ownerId === ownerId && job.idempotencyKey === idempotencyKey),
      findOpenFormat: async () => undefined,
      insert: async (record) => {
        records.push({ ...record });
      },
      abandon: async () => undefined,
      next: async () => undefined,
      save: async () => undefined,
      findById: async () => undefined,
    },
    cluster: {
      id: async () => "cluster-1",
      authenticate: async () => ({ id: "cluster-1", accepting: true }),
    },
    keys: { issue: async () => `dk_${"b".repeat(43)}` },
    accounts: { displayName: async () => "Ada Lovelace" },
  });
  return { jobs, computers, records };
}

describe("cloud image update job", () => {
  test("an update is queued before the create job has reported a container", async () => {
    const { jobs, computers, records } = hosts();
    const created = await jobs.ensureDefault({
      userId: "user-a",
      workspaceId: "workspace-1",
      now,
    });
    expect(computers[0]?.containerReady).toBe(false);
    const updated = await jobs.requestImageUpdate({
      userId: "user-a",
      workspaceId: "workspace-1",
      computerId: created.computerId,
      imageId: "sha256:new",
      now,
    });
    expect(updated.jobId).toBeTruthy();
    expect(records.at(-1)).toMatchObject({
      operation: "update",
      computerId: created.computerId,
      daemonApiKey: null,
    });
  });

  test("a missing computer is a page error, not a hidden failure", async () => {
    const { jobs } = hosts();
    const error = await jobs
      .requestImageUpdate({
        userId: "user-a",
        workspaceId: "workspace-1",
        computerId: "00000000-0000-4000-8000-000000000001",
        imageId: "sha256:new",
        now,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toEqual(new AppError("NOT_FOUND", { errorId: "cloud-computer-missing" }));
    expect(cloudImageUpdateError(new HostJobError(422, "invalid image id"))).toEqual({
      code: "INVALID_INPUT",
      errorId: "cloud-image-id-invalid",
    });
  });

  test("reporting an image replace reattaches workspaces that were only exec'd into the old task", async () => {
    const computers: CloudComputer[] = [];
    const records: HostJobRecord[] = [];
    const linked = new Map<string, Array<{ id: string; slug: string }>>();
    const jobs = new HostJobs({
      workspaces: {
        findMember: async (workspaceId, userId) =>
          userId === "user-a" && (workspaceId === "workspace-1" || workspaceId === "workspace-2")
            ? { id: workspaceId, slug: workspaceId === "workspace-1" ? "alpha" : "beta" }
            : undefined,
      },
      fleet: {
        list: async (ownerId) => computers.filter((computer) => computer.ownerId === ownerId),
        insert: async (computer) => {
          computers.push({ ...computer });
        },
        markReady: async (id) => {
          const computer = computers.find((item) => item.id === id);
          if (computer) computer.containerReady = true;
        },
        markDeleted: async () => undefined,
        forgetContainer: async () => undefined,
        linkedWorkspaces: async (computerId) => linked.get(computerId) ?? [],
        isLinked: async (computerId, workspaceId) =>
          (linked.get(computerId) ?? []).some((workspace) => workspace.id === workspaceId),
        link: async (computerId, workspaceId, slug) => {
          const current = linked.get(computerId) ?? [];
          if (!current.some((workspace) => workspace.id === workspaceId))
            current.push({ id: workspaceId, slug });
          linked.set(computerId, current);
        },
      },
      jobs: {
        findLatestCreate: async () => undefined,
        findByIdempotency: async (ownerId, idempotencyKey) =>
          records.find((job) => job.ownerId === ownerId && job.idempotencyKey === idempotencyKey),
        findOpenFormat: async () => undefined,
        insert: async (record) => {
          records.push({ ...record });
        },
        abandon: async () => undefined,
        next: async () => records.find((job) => job.reportedAt === null),
        save: async (record) => {
          const index = records.findIndex((job) => job.id === record.id);
          if (index >= 0) records[index] = { ...record };
        },
        findById: async (id) => records.find((job) => job.id === id),
      },
      cluster: {
        id: async () => "cluster-1",
        authenticate: async () => ({ id: "cluster-1", accepting: true }),
      },
      keys: { issue: async () => `dk_${"b".repeat(43)}` },
      accounts: { displayName: async () => "Ada Lovelace" },
    });
    const created = await jobs.ensureDefault({
      userId: "user-a",
      workspaceId: "workspace-1",
      now,
    });
    await jobs.report({
      token: "cluster-token",
      jobId: records[0]!.id,
      containerId: "service-1",
      now,
    });
    await jobs.ensureDefault({ userId: "user-a", workspaceId: "workspace-2", now });
    const attach = records.find((job) => job.operation === "attach");
    if (attach) await jobs.report({ token: "cluster-token", jobId: attach.id, now });
    const updated = await jobs.requestImageUpdate({
      userId: "user-a",
      workspaceId: "workspace-1",
      computerId: created.computerId,
      imageId: "sha256:new",
      now,
    });
    await jobs.report({ token: "cluster-token", jobId: updated.jobId!, now });
    expect(
      records.filter((job) => job.operation === "attach").map((job) => job.workspaceId),
    ).toEqual(["workspace-2", "workspace-2"]);
  });
});
