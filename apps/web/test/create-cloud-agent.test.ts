import { describe, expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { CreateCloudAgent } from "#src/server/agents/create-cloud-agent.server";

function fixture() {
  const created: { name: string; createRequestId?: string }[] = [];
  let existing: { id: string; ownerId: string; deletedAt: Date | null } | null = null;
  const taken = new Set<string>();
  const state = {
    cloud: "ready" as "ready" | "starting" | "offline" | "none",
    startPublished: true,
    startFailures: 0,
    stoppedAt: null as Date | null,
  };
  const calls: string[] = [];
  const starts: string[] = [];
  const useCase = new CreateCloudAgent({
    findByRequest: async (_workspaceId, requestId) =>
      existing && created.at(-1)?.createRequestId === requestId
        ? { ...existing, stoppedAt: state.stoppedAt }
        : null,
    cloudComputer: async () => {
      calls.push("cloud");
      return state.cloud === "none"
        ? { state: "none" }
        : { state: state.cloud, computerId: "cloud" };
    },
    create: async (_principal, input) => {
      if (existing || taken.has(input.name))
        throw new AppError("CONFLICT", { errorId: "agent-name-taken" });
      created.push(input);
      existing = { id: "agent", ownerId: "user", deletedAt: null };
      return { agent: existing, startPublished: state.startPublished };
    },
    start: async (_principal, agentId) => {
      starts.push(agentId);
      if (state.startFailures > 0) {
        state.startFailures--;
        throw new Error("transport unavailable");
      }
    },
  });
  return { useCase, state, created, calls, starts, taken };
}

const principal = { userId: "user", workspaceId: "workspace", role: "owner" as const };
const input = {
  name: "helper",
  displayName: "我的助手",
  requestId: "b4079160-26be-4edc-ac5d-a54a1d846e82",
};

describe("one-step cloud Agent creation", () => {
  test("creates a private Pi Agent inheriting the cloud's Configured default", async () => {
    const f = fixture();
    expect(await f.useCase.execute(principal, input)).toEqual({
      status: "created",
      agentId: "agent",
    });
    expect(f.created).toEqual([
      expect.objectContaining({
        displayName: "我的助手",
        computerId: "cloud",
        provider: "pi",
        visibility: "private",
        model: "",
        modelProvider: "",
      }),
    ]);
  });

  for (const cloud of ["starting", "offline", "none"] as const) {
    test(`creates nothing while the cloud computer is ${cloud}`, async () => {
      const f = fixture();
      f.state.cloud = cloud;
      expect(await f.useCase.execute(principal, input)).toEqual({ status: "unavailable" });
      expect(f.created).toEqual([]);
    });
  }

  test("a retry of a committed creation returns its Agent even after the computer went offline", async () => {
    const f = fixture();
    await f.useCase.execute(principal, input);
    f.state.cloud = "offline";
    expect(await f.useCase.execute(principal, input)).toEqual({
      status: "created",
      agentId: "agent",
    });
    expect(f.created).toHaveLength(1);
    expect(f.calls).toEqual(["cloud"]);
  });

  test("retains a created Agent and retries a failed Start", async () => {
    const f = fixture();
    f.state.startPublished = false;
    expect(await f.useCase.execute(principal, input)).toEqual({
      status: "start-deferred",
      agentId: "agent",
    });
    f.state.startFailures = 1;
    expect(await f.useCase.execute(principal, input)).toEqual({
      status: "start-deferred",
      agentId: "agent",
    });
    expect(await f.useCase.execute(principal, input)).toEqual({
      status: "created",
      agentId: "agent",
    });
    expect(f.created).toHaveLength(1);
    expect(f.starts).toEqual(["agent", "agent"]);
  });

  test("concurrent retries converge on the same Agent", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.useCase.execute(principal, input),
      f.useCase.execute(principal, input),
    ]);
    expect(results).toEqual([
      { status: "created", agentId: "agent" },
      { status: "created", agentId: "agent" },
    ]);
    expect(f.created).toHaveLength(1);
  });

  test("a creation retry preserves a later user Stop", async () => {
    const f = fixture();
    await f.useCase.execute(principal, input);
    f.state.stoppedAt = new Date();
    expect(await f.useCase.execute(principal, input)).toEqual({
      status: "created",
      agentId: "agent",
    });
    expect(f.starts).toEqual([]);
  });

  test("refuses unauthorized creation before reading the computer", async () => {
    const f = fixture();
    await expect(f.useCase.execute({ ...principal, role: "member" }, input)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(f.calls).toEqual([]);
  });

  test("the username is the one the user typed, and the request id is stored apart", async () => {
    const f = fixture();
    await f.useCase.execute(principal, input);
    expect(f.created).toEqual([
      expect.objectContaining({ name: "helper", createRequestId: input.requestId }),
    ]);
  });

  test("without a display name the Agent is shown by its username", async () => {
    const f = fixture();
    await f.useCase.execute(principal, { name: "helper", requestId: input.requestId });
    expect(f.created[0]).not.toHaveProperty("displayName", expect.anything());
  });

  test("a retry of the same request returns the Agent it created, whatever name it carries", async () => {
    const f = fixture();
    await f.useCase.execute(principal, input);
    expect(await f.useCase.execute(principal, { ...input, name: "renamed" })).toEqual({
      status: "created",
      agentId: "agent",
    });
    expect(f.created).toHaveLength(1);
  });

  test("another request for a username an Agent holds is refused as taken", async () => {
    const f = fixture();
    f.taken.add("helper");
    await expect(f.useCase.execute(principal, input)).rejects.toMatchObject({
      code: "CONFLICT",
      errorId: "agent-name-taken",
    });
    expect(f.created).toEqual([]);
  });
});
