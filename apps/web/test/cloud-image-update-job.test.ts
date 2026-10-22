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
});
