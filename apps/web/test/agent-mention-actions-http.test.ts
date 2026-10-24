import { expect, test } from "bun:test";
import { handleAgentMentionPendingGet } from "#src/routes/api/agent/v1/mention-actions_.pending";
import { handleAgentMentionExecutePost } from "#src/routes/api/agent/v1/mention-actions_.execute";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const RESOLUTION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

const pendingRequest = (query = "") =>
  new Request(`https://server.example/api/agent/v1/mention-actions/pending${query}`);

const pendingRow = (
  index: number,
  availableActions: Array<"notify" | "add"> = ["notify", "add"],
) => ({
  resolutionId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  messageId: "11111111-1111-4111-8111-111111111111",
  targetType: "user" as const,
  targetId: "33333333-3333-4333-8333-333333333333",
  targetHandle: `bob${index}`,
  targetLabel: "Bob",
  targetAvatarUrl: null,
  channelName: "triage",
  availableActions,
  expiresAt: new Date("2026-10-01T00:00:00Z"),
});

const executeRequest = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/mention-actions/execute", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("lists the calling Agent's pending mentions with the channel, reason, and ISO expiry", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentMentionPendingGet(pendingRequest(), principal, {
    pendingMentionActions: async (workspaceId, agentId) => {
      calls.push({ workspaceId, agentId });
      return [
        {
          resolutionId: RESOLUTION_ID,
          messageId: "11111111-1111-4111-8111-111111111111",
          targetType: "user",
          targetId: "33333333-3333-4333-8333-333333333333",
          targetHandle: "bob",
          targetLabel: "Bob",
          targetAvatarUrl: null,
          channelName: "triage",
          availableActions: ["notify", "add"],
          expiresAt: new Date("2026-10-01T00:00:00Z"),
        },
      ];
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    hasMore: false,
    noLongerActionable: 0,
    pendingMentionActions: [
      {
        resolutionId: RESOLUTION_ID,
        messageId: "11111111-1111-4111-8111-111111111111",
        targetType: "user",
        targetHandle: "bob",
        targetAvatarUrl: null,
        reason: "not_member",
        availableActions: ["notify", "add"],
        expiresAt: "2026-10-01T00:00:00.000Z",
        channelName: "triage",
      },
    ],
  });
  expect(calls).toEqual([{ workspaceId: "workspace-1", agentId: "agent-1" }]);
});

test("a page is the limit asked for and hasMore says whether an actionable row was left over", async () => {
  const deps = { pendingMentionActions: async () => [1, 2, 3].map((index) => pendingRow(index)) };
  const page = (await (
    await handleAgentMentionPendingGet(pendingRequest("?limit=2"), principal, deps)
  ).json()) as { hasMore: boolean; pendingMentionActions: unknown[] };
  expect(page.pendingMentionActions).toHaveLength(2);
  expect(page.hasMore).toBe(true);
  const whole = (await (
    await handleAgentMentionPendingGet(pendingRequest("?limit=3"), principal, deps)
  ).json()) as { hasMore: boolean; pendingMentionActions: unknown[] };
  expect(whole.pendingMentionActions).toHaveLength(3);
  expect(whole.hasMore).toBe(false);
});

test("a row that allows no action takes no place in the page and is only counted", async () => {
  // Three that are done, then two that can still be acted on.
  const rows = [
    pendingRow(1, []),
    pendingRow(2, []),
    pendingRow(3, []),
    pendingRow(4),
    pendingRow(5),
  ];
  const page = (await (
    await handleAgentMentionPendingGet(pendingRequest("?limit=1"), principal, {
      pendingMentionActions: async () => rows,
    })
  ).json()) as {
    hasMore: boolean;
    noLongerActionable: number;
    pendingMentionActions: Array<{ targetHandle: string }>;
  };
  expect(page.pendingMentionActions.map((row) => row.targetHandle)).toEqual(["bob4"]);
  expect(page.hasMore).toBe(true);
  expect(page.noLongerActionable).toBe(3);
});

test("when no row allows an action the page is empty and every row is counted", async () => {
  const page = (await (
    await handleAgentMentionPendingGet(pendingRequest(), principal, {
      pendingMentionActions: async () => [pendingRow(1, []), pendingRow(2, [])],
    })
  ).json()) as { hasMore: boolean; noLongerActionable: number; pendingMentionActions: unknown[] };
  expect(page).toEqual({
    ok: true,
    hasMore: false,
    noLongerActionable: 2,
    pendingMentionActions: [],
  });
});

test("a limit that is not a whole number from 1 to 100 is refused", async () => {
  const deps = {
    pendingMentionActions: async () => {
      throw new Error("must not be called");
    },
  };
  for (const limit of ["0", "101", "x", "1.5", ""]) {
    const response = await handleAgentMentionPendingGet(
      pendingRequest(`?limit=${limit}`),
      principal,
      deps,
    );
    expect(response.status).toBe(400);
  }
});

test("answers an Agent's add request with one refusal per requested id", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentMentionExecutePost(
    executeRequest({ action: "add", resolutionIds: [RESOLUTION_ID, OTHER_ID] }),
    principal,
    {
      notifyAgentMentionTargets: async () => {
        throw new Error("must not be called");
      },
      refuseAgentMentionAdds: async (workspaceId, agentId, resolutionIds) => {
        calls.push({ workspaceId, agentId, resolutionIds });
        return [
          {
            resolutionId: RESOLUTION_ID,
            status: "no_permission",
            reason: "add_requires_human_member_authority",
            targetType: "user",
            targetId: "33333333-3333-4333-8333-333333333333",
          },
          { resolutionId: OTHER_ID, status: "not_found" },
        ];
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    action: "add",
    results: [
      {
        resolutionId: RESOLUTION_ID,
        status: "no_permission",
        reason: "add_requires_human_member_authority",
        targetType: "user",
        targetId: "33333333-3333-4333-8333-333333333333",
      },
      { resolutionId: OTHER_ID, status: "not_found" },
    ],
  });
  expect(calls).toEqual([
    { workspaceId: "workspace-1", agentId: "agent-1", resolutionIds: [RESOLUTION_ID, OTHER_ID] },
  ]);
});

test("carries out an Agent's notify request and answers one result per requested id", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentMentionExecutePost(
    executeRequest({ action: "notify", resolutionIds: [RESOLUTION_ID] }),
    principal,
    {
      notifyAgentMentionTargets: async (workspaceId, agentId, resolutionIds) => {
        calls.push({ workspaceId, agentId, resolutionIds });
        return [{ resolutionId: RESOLUTION_ID, status: "queued" }];
      },
      refuseAgentMentionAdds: async () => {
        throw new Error("must not be called");
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    action: "notify",
    results: [{ resolutionId: RESOLUTION_ID, status: "queued" }],
  });
  expect(calls).toEqual([
    { workspaceId: "workspace-1", agentId: "agent-1", resolutionIds: [RESOLUTION_ID] },
  ]);
});

test("rejects a malformed mention action request with an invalid_request envelope", async () => {
  const refuse = async () => {
    throw new Error("must not be called");
  };
  const tooMany = Array.from(
    { length: 21 },
    (_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  );
  for (const body of [
    "not json",
    { action: "remove", resolutionIds: [RESOLUTION_ID] },
    { resolutionIds: [RESOLUTION_ID] },
    { action: "add", resolutionIds: [] },
    { action: "add", resolutionIds: tooMany },
    { action: "add", resolutionIds: ["not-a-uuid"] },
    { action: "add", resolutionIds: RESOLUTION_ID },
  ]) {
    const response = await handleAgentMentionExecutePost(executeRequest(body), principal, {
      notifyAgentMentionTargets: refuse,
      refuseAgentMentionAdds: refuse,
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as { ok: boolean; errorCode: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe("invalid_request");
    expect(typeof json.error).toBe("string");
  }
});
