import { describe, expect, test } from "bun:test";
import { encodeAgentActivity } from "@lrm/coforge-sdk/internal";

import {
  handleAgentActivityPublication,
  publicationAgentLookups,
} from "#src/server/agents/agent-activity-publish.server";
import { cachedWorkspaceComputerCheck } from "#src/server/agents/workspace-computer-cache.server";
import type { PrismaClient } from "#src/generated/prisma/client";

describe("cachedWorkspaceComputerCheck", () => {
  function subject(options: { ttlMs?: number; maxEntries?: number } = {}) {
    let now = 0;
    const reads: string[] = [];
    const { check, forget } = cachedWorkspaceComputerCheck(
      async (workspaceId, computerId) => {
        reads.push(`${workspaceId}:${computerId}`);
        return computerId !== "nowhere";
      },
      { ttlMs: 30_000, maxEntries: 2, now: () => now, ...options },
    );
    return { check, forget, reads, advance: (ms: number) => (now += ms) };
  }

  const scope = { workspaceId: "w", computerId: "c1" } as const;

  test("a daemon's repeats renew the answer and an idle entry expires", async () => {
    const { check, reads, advance } = subject();
    expect(await check(scope.workspaceId, scope.computerId)).toBe(true);
    advance(8_000);
    expect(await check(scope.workspaceId, scope.computerId)).toBe(true);
    advance(29_999);
    await check(scope.workspaceId, scope.computerId);
    expect(reads).toHaveLength(1);
    advance(30_000);
    await check(scope.workspaceId, scope.computerId);
    expect(reads).toHaveLength(2);
  });

  test("a different Computer or Workspace is its own entry", async () => {
    const { check, reads } = subject({ maxEntries: 10 });
    await check("w", "c1");
    await check("w", "c2");
    await check("x", "c1");
    expect(reads).toHaveLength(3);
  });

  test("only a Computer that belongs is remembered: a negative or failed check is asked again", async () => {
    const { check, reads } = subject();
    expect(await check("w", "nowhere")).toBe(false);
    expect(await check("w", "nowhere")).toBe(false);
    expect(reads).toHaveLength(2);

    let attempts = 0;
    const flaky = cachedWorkspaceComputerCheck(async () => {
      if (++attempts === 1) throw new Error("database unavailable");
      return true;
    }).check;
    await expect(flaky("w", "c1")).rejects.toThrow();
    expect(await flaky("w", "c1")).toBe(true);
  });

  test("it holds a bounded number of entries and forgets the oldest", async () => {
    const { check, reads } = subject({ maxEntries: 2 });
    await check("w", "c1");
    await check("w", "c2");
    await check("w", "c3");
    await check("w", "c3");
    expect(reads).toHaveLength(3);
    await check("w", "c1");
    expect(reads).toHaveLength(4);
  });

  test("forget drops only that Computer's answers, in every Workspace", async () => {
    const { check, forget, reads } = subject({ maxEntries: 10 });
    await check("w", "c1");
    await check("w2", "c1");
    await check("w", "c2");
    forget("c1");
    await check("w", "c1");
    await check("w2", "c1");
    await check("w", "c2");
    expect(reads).toEqual(["w:c1", "w2:c1", "w:c2", "w:c1", "w2:c1"]);
  });

  test("forget with no id flushes every remembered answer", async () => {
    const { check, forget, reads } = subject({ maxEntries: 10 });
    await check("w", "c1");
    await check("w", "c2");
    forget();
    await check("w", "c1");
    await check("w", "c2");
    expect(reads).toEqual(["w:c1", "w:c2", "w:c1", "w:c2"]);
  });

  test("an answer that resolves after forget is not remembered", async () => {
    // A check issued before the ownership change commits can resolve after `forget` ran: the
    // stale "belongs" it carries answers this call but never re-enters the cache.
    const resolvers: ((value: boolean) => void)[] = [];
    const { check, forget } = cachedWorkspaceComputerCheck(
      () => new Promise<boolean>((resolve) => resolvers.push(resolve)),
    );
    const first = check("w", "c1");
    forget("c1");
    resolvers.pop()!(true);
    expect(await first).toBe(true);
    const second = check("w", "c1");
    expect(resolvers).toHaveLength(1);
    resolvers.pop()!(true);
    expect(await second).toBe(true);
  });

  test("an answer that resolves after a flush is not remembered", async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { check, forget } = cachedWorkspaceComputerCheck(
      () => new Promise<boolean>((resolve) => resolvers.push(resolve)),
    );
    const first = check("w", "c1");
    forget();
    resolvers.pop()!(true);
    expect(await first).toBe(true);
    const second = check("w", "c1");
    expect(resolvers).toHaveLength(1);
    resolvers.pop()!(true);
    expect(await second).toBe(true);
  });
});

/** A second frame on one daemon connection must not re-read the same workspaceComputer row. */
describe("publication Computer scope cache", () => {
  const activity = {
    protocolMajor: 1,
    requestId: "activity-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    detailKind: "tool_started",
    level: "info",
    detail: "Running a tool",
    observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
    launchId: "launch-1",
    clientSeq: 1,
  } as const;

  const request = () =>
    new Request("http://backend/api/internal/centrifugo-agent-activity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-coforge-centrifugo-proxy-secret": "test-secret",
      },
      body: JSON.stringify({
        user: "user-1",
        channel: "agent:activity:workspace-1",
        b64data: (() => {
          let binary = "";
          for (const byte of encodeAgentActivity(activity)) binary += String.fromCharCode(byte);
          return btoa(binary);
        })(),
        meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
      }),
    });

  const storedAgent = {
    workspaceId: "workspace-1",
    computerId: "computer-1",
    visibility: "public",
    runtimeSession: {
      computerId: "computer-1",
      daemonInstanceId: "daemon-1",
      launchId: "launch-1",
    },
  };

  test("two frames share one workspaceComputer read while the Agent row stays fresh per frame", async () => {
    const agentReads: unknown[] = [];
    const computerReads: unknown[] = [];
    const db = {
      agent: {
        findUnique: async (query: unknown) => {
          agentReads.push(query);
          return storedAgent;
        },
      },
      workspaceComputer: {
        findUnique: async (query: unknown) => {
          computerReads.push(query);
          return { id: "row-1" };
        },
      },
    } as unknown as PrismaClient;
    // Wired once, as `createAgentActivityPublicationHandler` wires it for the process; the Agent
    // lookups are built per publication exactly as the handler builds them.
    const computerBelongsToWorkspace = cachedWorkspaceComputerCheck(
      async (workspaceId, computerId) =>
        Boolean(
          await db.workspaceComputer.findUnique({
            where: { workspaceId_computerId: { workspaceId, computerId } },
            select: { id: true },
          }),
        ),
    ).check;

    for (let frame = 0; frame < 2; frame++) {
      const response = await handleAgentActivityPublication(request(), {
        proxySecret: "test-secret",
        computerBelongsToWorkspace,
        ...publicationAgentLookups(db),
        observe: async () => {},
      });
      expect(response.status).toBe(200);
      expect((await response.json()).result.skip_history).toBe(true);
    }
    expect(computerReads).toHaveLength(1);
    expect(agentReads).toHaveLength(2);
  });

  test("a denied pair is asked again on the next frame, not cached", async () => {
    let belongs = false;
    const computerReads: unknown[] = [];
    const computerBelongsToWorkspace = cachedWorkspaceComputerCheck(async () => {
      computerReads.push({});
      return belongs;
    }).check;
    const dependencies = {
      proxySecret: "test-secret",
      computerBelongsToWorkspace,
      agentVisibility: async () => "public" as const,
      agentBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => true,
      observe: async () => {},
    };

    const denied = await handleAgentActivityPublication(request(), dependencies);
    expect((await denied.json()).error).toBeDefined();
    belongs = true;
    const allowed = await handleAgentActivityPublication(request(), dependencies);
    expect((await allowed.json()).result.skip_history).toBe(true);
    expect(computerReads).toHaveLength(2);
  });
});
