import { describe, expect, test } from "bun:test";
import {
  AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
  AGENT_SIDE_ASK_MAX_TIMEOUT_MS,
  AGENT_SIDE_ASK_QUESTION_MAX_CHARS,
  encodeAgentSideAskResult,
  type AgentSideAskRequest,
  type AgentSideAskResult,
} from "@lrm/coforge-sdk/internal";
import {
  createAgentSideAskResultMethod,
  RedisAgentSideAskResults,
} from "#src/server/centrifugo/agent-side-ask-results.server";
import {
  ComputerAgentSideAsks,
  sameAgentSideAskScope,
} from "#src/server/computers/computer-agent-side-asks.server";
import { computerAgentSideAsks } from "#src/server/computers/computer-agent-side-asks-production.server";

function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    },
    async send(command: string, args: string[]) {
      if (command === "DEL") {
        for (const key of args) store.delete(key);
        return args.length;
      }
      if (command === "EVAL") {
        const [, , pendingKey, resultKey, expectedPending, encodedResult] = args;
        if (store.get(pendingKey!) !== expectedPending) return 0;
        if (store.has(resultKey!)) return 0;
        store.set(resultKey!, encodedResult!);
        return 1;
      }
      throw new Error(`Unexpected command ${command}`);
    },
  };
}

describe("ComputerAgentSideAsks and RedisAgentSideAskResults", () => {
  test("starts a side ask, accepts scoped daemon reply, and enforces per-user read isolation", async () => {
    const redis = createFakeRedis();
    const results = new RedisAgentSideAskResults(redis as never);
    const published: AgentSideAskRequest[] = [];
    let visible = true;

    const service = new ComputerAgentSideAsks({
      resolveTarget: async (viewer) => ({
        computerId: "comp-1",
        asker: {
          userId: viewer.userId,
          displayName: "Frank",
          role: "owner",
          isAgentOwner: true,
        },
      }),
      visible: async () => visible,
      online: async () => true,
      supported: async () => true,
      publish: async (request) => {
        published.push(request);
      },
      results,
    });

    const viewerA = { userId: "user-a", workspaceId: "ws-1" };
    const viewerB = { userId: "user-b", workspaceId: "ws-1" };

    const started = await service.start(viewerA, {
      agentId: "agent-1",
      kind: "question",
      question: "  What branch are you on?  ",
      timeoutMs: 999_999,
    });
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("expected started");
    expect(published).toHaveLength(1);
    expect(published[0]!.question).toBe("What branch are you on?");
    expect(published[0]!.timeoutMs).toBe(AGENT_SIDE_ASK_MAX_TIMEOUT_MS);

    expect(
      await service.read(viewerA, {
        agentId: "agent-1",
        computerId: "comp-1",
        requestId: started.requestId,
      }),
    ).toEqual({ status: "pending" });

    const rpcMethod = createAgentSideAskResultMethod(results);
    const daemonResult: AgentSideAskResult = {
      protocolMajor: 1,
      requestId: started.requestId,
      workspaceId: "ws-1",
      computerId: "comp-1",
      agentId: "agent-1",
      askerUserId: "user-a",
      kind: "question",
      status: "ok",
      answer: "Currently on main.",
      runtime: "claude-code",
      durationMs: 800,
    };

    const unauthorized = await rpcMethod(encodeAgentSideAskResult(daemonResult), {
      principal: { userId: "owner-1", workspaceId: "ws-1", computerId: "comp-other" },
    } as never);
    expect(unauthorized).toMatchObject({ code: 403 });

    const agentCaller = await rpcMethod(encodeAgentSideAskResult(daemonResult), {
      principal: { userId: "owner-1", workspaceId: "ws-1", computerId: "comp-1", agentId: "a1" },
    } as never);
    expect(agentCaller).toMatchObject({ code: 403 });

    const spoofedAsker: AgentSideAskResult = { ...daemonResult, askerUserId: "user-b" };
    await rpcMethod(encodeAgentSideAskResult(spoofedAsker), {
      principal: { userId: "owner-1", workspaceId: "ws-1", computerId: "comp-1" },
    } as never);
    expect(await results.read(started.requestId)).toBeUndefined();

    const accepted = await rpcMethod(encodeAgentSideAskResult(daemonResult), {
      principal: { userId: "owner-1", workspaceId: "ws-1", computerId: "comp-1" },
    } as never);
    expect(accepted).toBeInstanceOf(Uint8Array);

    expect(
      await service.read(viewerB, {
        agentId: "agent-1",
        computerId: "comp-1",
        requestId: started.requestId,
      }),
    ).toEqual({ status: "pending" });

    expect(
      await service.read(viewerA, {
        agentId: "agent-1",
        computerId: "comp-1",
        requestId: started.requestId,
      }),
    ).toEqual({ status: "ready", result: daemonResult });

    visible = false;
    expect(
      await service.read(viewerA, {
        agentId: "agent-1",
        computerId: "comp-1",
        requestId: started.requestId,
      }),
    ).toEqual({ status: "unavailable", reason: "not_found" });
  });

  test("validates input, offline state, old daemon, and missing computer", async () => {
    const redis = createFakeRedis();
    const results = new RedisAgentSideAskResults(redis as never);
    let computerId: string | null = "comp-1";
    let isOnline = true;
    let isSupported = true;
    let found = true;

    const service = new ComputerAgentSideAsks({
      resolveTarget: async (viewer) =>
        found
          ? {
              computerId,
              asker: {
                userId: viewer.userId,
                displayName: "Alex",
                role: "member",
                isAgentOwner: false,
              },
            }
          : undefined,
      visible: async () => true,
      online: async () => isOnline,
      supported: async () => isSupported,
      publish: async () => {},
      results,
    });

    const viewer = { userId: "user-1", workspaceId: "ws-1" };

    expect(
      await service.start(viewer, { agentId: "a-1", kind: "question", question: "   " }),
    ).toEqual({ status: "unavailable", reason: "invalid_input" });

    expect(
      await service.start(viewer, {
        agentId: "a-1",
        kind: "question",
        question: "x".repeat(AGENT_SIDE_ASK_QUESTION_MAX_CHARS + 1),
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_input" });

    expect(
      await service.start(viewer, { agentId: "a-1", kind: "status", question: "not allowed" }),
    ).toEqual({ status: "unavailable", reason: "invalid_input" });

    found = false;
    expect(await service.start(viewer, { agentId: "a-1", kind: "status" })).toEqual({
      status: "unavailable",
      reason: "not_found",
    });

    found = true;
    computerId = null;
    expect(await service.start(viewer, { agentId: "a-1", kind: "status" })).toEqual({
      status: "unavailable",
      reason: "no_computer",
    });

    computerId = "comp-1";
    isOnline = false;
    expect(await service.start(viewer, { agentId: "a-1", kind: "status" })).toEqual({
      status: "offline",
      reason: "offline",
    });

    isOnline = true;
    isSupported = false;
    expect(await service.start(viewer, { agentId: "a-1", kind: "status" })).toEqual({
      status: "unsupported",
      reason: "old_daemon",
    });
  });

  test("sameAgentSideAskScope rejects mismatched fields including askerUserId", () => {
    const request: AgentSideAskRequest = {
      protocolMajor: 1,
      requestId: "sask_0123456789abcdef0123456789abcdef",
      workspaceId: "ws-1",
      computerId: "comp-1",
      agentId: "agent-1",
      kind: "status",
      question: "",
      timeoutMs: AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
      asker: { userId: "user-1", displayName: "Frank", role: "owner", isAgentOwner: true },
    };
    const result: AgentSideAskResult = {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: "ws-1",
      computerId: "comp-1",
      agentId: "agent-1",
      askerUserId: "user-1",
      kind: "status",
      status: "ok",
      answer: "State: idle [codex]",
      durationMs: 10,
    };
    expect(sameAgentSideAskScope(request, result)).toBe(true);
    expect(sameAgentSideAskScope(request, { ...result, askerUserId: "user-2" })).toBe(false);
    expect(sameAgentSideAskScope(request, { ...result, kind: "question" })).toBe(false);
  });

  test("production composition enforces visibility and treats deleted or unlinked computer as no_computer", async () => {
    const privateAgent = {
      id: "agent-priv",
      visibility: "private",
      ownerId: "user-owner",
      systemKind: null,
      computerId: "comp-1",
      computer: { id: "comp-1", deletedAt: null, workspaces: [{ workspaceId: "ws-1" }] },
    };
    const deletedComputerAgent = {
      id: "agent-del-comp",
      visibility: "public",
      ownerId: "user-1",
      systemKind: null,
      computerId: "comp-deleted",
      computer: {
        id: "comp-deleted",
        deletedAt: new Date(),
        workspaces: [{ workspaceId: "ws-1" }],
      },
    };
    const unlinkedComputerAgent = {
      id: "agent-unlinked",
      visibility: "public",
      ownerId: "user-1",
      systemKind: null,
      computerId: "comp-unlinked",
      computer: { id: "comp-unlinked", deletedAt: null, workspaces: [] },
    };
    const db = {
      agent: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === "agent-priv"
            ? privateAgent
            : where.id === "agent-del-comp"
              ? deletedComputerAgent
              : where.id === "agent-unlinked"
                ? unlinkedComputerAgent
                : null,
      },
      workspaceMembership: {
        findUnique: async () => ({ role: "member" }),
      },
      user: {
        findUnique: async () => ({ displayName: "Member One" }),
      },
    };

    const service = computerAgentSideAsks(db as never);
    expect(
      await service.start(
        { userId: "user-other", workspaceId: "ws-1" },
        { agentId: "agent-priv", kind: "status" },
      ),
    ).toEqual({ status: "unavailable", reason: "not_found" });

    expect(
      await service.start(
        { userId: "user-1", workspaceId: "ws-1" },
        { agentId: "agent-del-comp", kind: "status" },
      ),
    ).toEqual({ status: "unavailable", reason: "no_computer" });

    expect(
      await service.start(
        { userId: "user-1", workspaceId: "ws-1" },
        { agentId: "agent-unlinked", kind: "status" },
      ),
    ).toEqual({ status: "unavailable", reason: "no_computer" });

    expect(
      await service.read(
        { userId: "user-1", workspaceId: "ws-1" },
        { computerId: "comp-1", agentId: "agent-1", requestId: "not-a-valid-request-id" },
      ),
    ).toEqual({ status: "pending" });

    const rpc = createAgentSideAskResultMethod({ accept: async () => true });
    expect(
      await rpc(new Uint8Array([1, 2, 3]), {
        principal: { userId: "u-1", workspaceId: "ws-1", computerId: "comp-1" },
      } as never),
    ).toEqual({ code: 400, message: "Invalid agent side ask result" });
    expect(
      await rpc(new Uint8Array([1, 2, 3]), {
        principal: { userId: "u-1", workspaceId: "ws-1", agentId: "agent-1" },
      } as never),
    ).toEqual({ code: 403, message: "Agent side ask result scope is not authorized" });
  });
});
