import { expect, test } from "bun:test";
import {
  encodeAgentSkillsListResult,
  type AgentSkillsListRequest,
  type AgentSkillsListResult,
} from "@lrm/coforge-sdk/internal";
import { AgentSkillsQuery, type SkillsAssignment } from "#src/server/agents/agent-skills.server";
import { createAgentSkillsListResultMethod } from "#src/server/centrifugo/agent-skills-cache.server";
import { daemonOnline } from "#src/server/centrifugo/server-api.server";

test("Skills query binds the owner's assignment and rechecks it before returning metadata", async () => {
  let assignment: { computerId: string; provider: "codex"; revision: string } | undefined = {
    computerId: "computer",
    provider: "codex",
    revision: "one",
  };
  let request: AgentSkillsListRequest | undefined;
  let reads = 0;
  let cleared = 0;
  const query = new AgentSkillsQuery({
    findOwned: async () => {
      reads++;
      return assignment;
    },
    online: async () => true,
    publish: async (value) => {
      request = value;
    },
    results: {
      begin: async () => {},
      read: async () => {
        assignment = undefined; // Membership/ownership revoked while waiting.
        return {
          ...request!,
          scannedAtMs: 1,
          global: {
            status: "ok",
            entries: [
              {
                name: "private",
                displayName: "private",
                description: "",
                userInvocable: false,
                sourcePath: "~/.agents/skills",
              },
            ],
            directories: [],
          },
          workspace: { status: "ok", entries: [], directories: [] },
        } satisfies AgentSkillsListResult;
      },
      wait: async () => false,
      clear: async () => {
        cleared++;
      },
    },
  });
  expect(await query.get({ userId: "owner", workspaceId: "workspace" }, "agent")).toEqual({
    status: "unavailable",
  });
  expect(request).toMatchObject({
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
  });
  expect(reads).toBe(2);
  expect(cleared).toBe(1);
  request = undefined;
  expect(await query.get({ userId: "other", workspaceId: "workspace" }, "agent")).toEqual({
    status: "unavailable",
  });
  expect(request).toBeUndefined();
});

test.each(["ready", "offline", "timeout", "moved", "reconfigured", "wrong-result"])(
  "Skills query handles %s without leaking stale metadata",
  async (scenario) => {
    let assignment: SkillsAssignment = {
      computerId: "computer",
      provider: "codex",
      revision: "one",
    };
    let request: AgentSkillsListRequest | undefined;
    let now = 0;
    const query = new AgentSkillsQuery(
      {
        findOwned: async () => assignment,
        online: async () => scenario !== "offline",
        publish: async (value) => {
          request = value;
        },
        results: {
          begin: async () => {},
          clear: async () => {},
          read: async () => {
            if (scenario === "timeout") return undefined;
            if (scenario === "moved") assignment = { ...assignment, computerId: "other" };
            if (scenario === "reconfigured") assignment = { ...assignment, revision: "two" };
            return {
              ...request!,
              agentId: scenario === "wrong-result" ? "other" : "agent",
              scannedAtMs: 1,
              global: { status: "ok", entries: [], directories: [] },
              workspace: { status: "ok", entries: [], directories: [] },
            };
          },
          wait: async (_requestId: string, timeoutMs: number) => {
            now += timeoutMs;
            return false;
          },
        },
      },
      {
        now: () => now,
        timeoutMs: 200,
        fallbackMs: 100,
      },
    );
    const response = await query.get({ userId: "owner", workspaceId: "workspace" }, "agent");
    expect(response.status).toBe(
      scenario === "ready" || scenario === "offline" || scenario === "timeout"
        ? scenario
        : "unavailable",
    );
    if (scenario === "offline") expect(request).toBeUndefined();
  },
);

test("Skills result RPC trusts daemon claims rather than claimed payload scope", async () => {
  const result: AgentSkillsListResult = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
    scannedAtMs: 1,
    global: { status: "ok", entries: [], directories: [] },
    workspace: { status: "ok", entries: [], directories: [] },
  };
  let accepted = 0;
  const method = createAgentSkillsListResultMethod({
    accept: async () => {
      accepted++;
      return true;
    },
  });
  const bytes = encodeAgentSkillsListResult(result);
  for (const principal of [
    { userId: "", workspaceId: "workspace", computerId: "computer" },
    { userId: "user", workspaceId: "other", computerId: "computer" },
    { userId: "user", workspaceId: "workspace", computerId: "other" },
    { userId: "user", workspaceId: "workspace", computerId: "computer", agentId: "agent" },
  ])
    expect(await method(bytes, { principal })).toMatchObject({ code: 403 });
  expect(accepted).toBe(0);
  expect(
    await method(bytes, {
      principal: { userId: "user", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toBeInstanceOf(Uint8Array);
  expect(accepted).toBe(1);
});

test("Skills query wakes on a stored result and still bounds each wait slice", async () => {
  let request: AgentSkillsListRequest | undefined;
  let reads = 0;
  const waits: { requestId: string; timeoutMs: number }[] = [];
  const query = new AgentSkillsQuery(
    {
      findOwned: async () => ({ computerId: "computer", provider: "codex", revision: "one" }),
      online: async () => true,
      publish: async (value) => {
        request = value;
      },
      results: {
        begin: async () => {},
        read: async () => {
          reads++;
          if (reads === 1) return undefined;
          return {
            ...request!,
            scannedAtMs: 1,
            global: { status: "ok", entries: [], directories: [] },
            workspace: { status: "ok", entries: [], directories: [] },
          };
        },
        wait: async (requestId, timeoutMs) => {
          waits.push({ requestId, timeoutMs });
          return true; // The stored result's notification woke the wait.
        },
        clear: async () => {},
      },
    },
    { now: Date.now, timeoutMs: 5_000, fallbackMs: 1_000 },
  );
  const response = await query.get({ userId: "owner", workspaceId: "workspace" }, "agent");
  expect(response.status).toBe("ready");
  expect(waits).toEqual([{ requestId: request!.requestId, timeoutMs: 1_000 }]);
});

test("Skills query keeps its deadline when notifications never arrive", async () => {
  let now = 0;
  const waits: number[] = [];
  const query = new AgentSkillsQuery(
    {
      findOwned: async () => ({ computerId: "computer", provider: "codex", revision: "one" }),
      online: async () => true,
      publish: async () => {},
      results: {
        begin: async () => {},
        read: async () => undefined,
        wait: async (_requestId, timeoutMs) => {
          waits.push(timeoutMs);
          now += timeoutMs;
          return false;
        },
        clear: async () => {},
      },
    },
    { now: () => now, timeoutMs: 2_500, fallbackMs: 1_000 },
  );
  expect(await query.get({ userId: "owner", workspaceId: "workspace" }, "agent")).toEqual({
    status: "timeout",
  });
  // Slices shrink with the remaining deadline: 1000, 1000, then the 500 left.
  expect(waits).toEqual([1_000, 1_000, 500]);
});

test("daemon online needs the status cache and a live channel subscriber", async () => {
  const scope = { workspaceId: "workspace", computerId: "computer" };
  const clients = [{ client: "c", user: "u" }];
  let presenceCalls = 0;
  const api = {
    presence: async () => {
      presenceCalls++;
      return clients;
    },
  };
  const status = (online: boolean) => ({ get: async () => online });

  // Cache says offline: presence is never asked, the answer is offline at once.
  expect(await daemonOnline(() => api, status(false))(scope)).toBe(false);
  expect(presenceCalls).toBe(0);

  // Cache says online but nobody is subscribed: the publish would be dropped.
  const emptyApi = { presence: async () => [] };
  expect(await daemonOnline(() => emptyApi, status(true))(scope)).toBe(false);

  // A presence read that fails keeps the old path: publish and let the timeout bound it.
  const brokenApi = {
    presence: async () => {
      throw new Error("centrifugo unreachable");
    },
  };
  expect(await daemonOnline(() => brokenApi, status(true))(scope)).toBe(true);

  expect(await daemonOnline(() => api, status(true))(scope)).toBe(true);
});
