import { describe, expect, test } from "bun:test";
import {
  RUNTIME_MANAGE_CAPABILITY,
  RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
  RUNTIME_PROVIDER,
  encodeRuntimeManageResult,
  type RuntimeManageRequest,
  type RuntimeManageResult,
} from "@lrm/coforge-sdk/internal";
import {
  RedisRuntimeManageResults,
  createRuntimeManageResultMethod,
} from "#src/server/centrifugo/runtime-manage-results.server";
import {
  ComputerRuntimeManage,
  sameRuntimeManageScope,
} from "#src/server/computers/computer-runtime-manage.server";

function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK" as const;
    },
    async send(command: string, args: string[]) {
      if (command.toUpperCase() === "DEL") {
        let count = 0;
        for (const key of args) {
          if (store.delete(key)) count += 1;
        }
        return count;
      }
      if (command.toUpperCase() === "EVAL") {
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

describe("ComputerRuntimeManage orchestration and scope security", () => {
  test("gates start on authorization, online status, and runtime-manage:v1 capability, then reads result per user", async () => {
    const redis = createFakeRedis();
    const results = new RedisRuntimeManageResults(redis);
    const published: RuntimeManageRequest[] = [];
    const manager = new ComputerRuntimeManage({
      authorized: async (viewer, computerId) =>
        viewer.userId === "user-owner" && computerId === "comp-1",
      online: async () => true,
      supported: async () => true,
      publish: async (request) => {
        published.push(request);
      },
      results: {
        begin: (pending) => results.begin(pending),
        read: (requestId) => results.read(requestId),
        clear: (requestId) => results.clear(requestId),
      },
    });

    const unauthorized = await manager.start(
      { userId: "user-member", workspaceId: "ws-1" },
      { computerId: "comp-1", provider: RUNTIME_PROVIDER.CODEX, action: "install" },
    );
    expect(unauthorized).toEqual({ status: "unavailable", reason: "not_found" });

    const started = await manager.start(
      { userId: "user-owner", workspaceId: "ws-1" },
      { computerId: "comp-1", provider: RUNTIME_PROVIDER.CODEX, action: "install" },
    );
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      requestId: started.requestId,
      workspaceId: "ws-1",
      computerId: "comp-1",
      provider: RUNTIME_PROVIDER.CODEX,
      action: "install",
      requestedByUserId: "user-owner",
      timeoutMs: RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
    });

    expect(
      await manager.read(
        { userId: "user-owner", workspaceId: "ws-1" },
        { computerId: "comp-1", provider: RUNTIME_PROVIDER.CODEX, requestId: started.requestId },
      ),
    ).toEqual({ status: "pending" });

    const rpc = createRuntimeManageResultMethod(results);
    const validResult: RuntimeManageResult = {
      protocolMajor: 1,
      requestId: started.requestId,
      workspaceId: "ws-1",
      computerId: "comp-1",
      provider: RUNTIME_PROVIDER.CODEX,
      action: "install",
      requestedByUserId: "user-owner",
      status: "installed",
      source: "npm",
      currentVersion: "0.151.0",
      durationMs: 4_200,
    };

    const foreignDaemon = await rpc(encodeRuntimeManageResult(validResult), {
      principal: { userId: "daemon", workspaceId: "ws-1", computerId: "comp-other" },
    });
    expect(foreignDaemon).toMatchObject({ code: 403 });

    const accepted = await rpc(encodeRuntimeManageResult(validResult), {
      principal: { userId: "daemon", workspaceId: "ws-1", computerId: "comp-1" },
    });
    expect(accepted).toBeInstanceOf(Uint8Array);

    const otherUserRead = await manager.read(
      { userId: "user-other", workspaceId: "ws-1" },
      { computerId: "comp-1", provider: RUNTIME_PROVIDER.CODEX, requestId: started.requestId },
    );
    expect(otherUserRead).toEqual({ status: "pending" });

    const ready = await manager.read(
      { userId: "user-owner", workspaceId: "ws-1" },
      { computerId: "comp-1", provider: RUNTIME_PROVIDER.CODEX, requestId: started.requestId },
    );
    expect(ready).toEqual({ status: "ready", result: validResult });
  });

  test("rejects old daemon lacking runtime-manage:v1 capability and blocks scope spoofing", async () => {
    const redis = createFakeRedis();
    const results = new RedisRuntimeManageResults(redis);
    const manager = new ComputerRuntimeManage({
      authorized: async () => true,
      online: async () => true,
      supported: async () => false,
      publish: async () => {},
      results: {
        begin: (pending) => results.begin(pending),
        read: (requestId) => results.read(requestId),
      },
    });

    expect(RUNTIME_MANAGE_CAPABILITY).toBe("runtime-manage:v1");
    expect(
      await manager.start(
        { userId: "user-owner", workspaceId: "ws-1" },
        { computerId: "comp-1", provider: RUNTIME_PROVIDER.CLAUDE_CODE, action: "upgrade" },
      ),
    ).toEqual({ status: "unsupported", reason: "old_daemon" });

    const req: RuntimeManageRequest = {
      protocolMajor: 1,
      requestId: "rtm_0123456789abcdef0123456789abcdef",
      workspaceId: "ws-1",
      computerId: "comp-1",
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      action: "upgrade",
      requestedByUserId: "user-owner",
      timeoutMs: RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
    };
    const spoofed: RuntimeManageResult = {
      ...req,
      provider: RUNTIME_PROVIDER.CODEX,
      status: "upgraded",
      durationMs: 100,
    };
    expect(sameRuntimeManageScope(req, spoofed)).toBe(false);
  });
});
