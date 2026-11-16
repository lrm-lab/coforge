import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { handleExternalAgentControl } from "#src/server/agents/external-agent-control.server";

function fakeDb(
  agent: {
    hosting: string;
    ownerId?: string;
    stoppedAt?: Date | null;
    deletedAt?: Date | null;
  } | null,
  role = "member",
) {
  const writes: { table: string; where?: unknown; data?: unknown }[] = [];
  const row = agent && { ownerId: "owner", stoppedAt: null, deletedAt: null, ...agent };
  const tables = {
    agent: {
      findFirst: async () => row,
      update: async (args: { data: unknown }) => {
        writes.push({ table: "agent", data: args.data });
      },
    },
    workspaceMembership: { findUnique: async () => ({ role }) },
    agentMessageDelivery: {
      updateMany: async (args: { data: unknown }) => {
        writes.push({ table: "delivery", data: args.data });
      },
    },
    externalAgentCredential: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        writes.push({ table: "credential", ...args });
        return { count: 2 };
      },
    },
  };
  return {
    writes,
    db: {
      ...tables,
      $transaction: async (work: (tx: unknown) => unknown) => work(tables),
    } as never as PrismaClient,
  };
}

const AT = new Date("2026-11-16T00:00:00Z");
const input = (
  action: "start" | "stop" | "restart" | "reset-session" | "full-reset",
  userId = "owner",
) => ({
  userId,
  workspaceId: "ws",
  agentId: "agent",
  action,
});

describe("control of an external Agent", () => {
  test("a managed Agent is left to the Computer path", async () => {
    const { db, writes } = fakeDb({ hosting: "managed" });
    expect(await handleExternalAgentControl(db, input("stop"))).toBe(false);
    expect(writes).toEqual([]);
  });

  test("stop records the intent and revokes every key as agent_stopped", async () => {
    const { db, writes } = fakeDb({ hosting: "external" });
    expect(await handleExternalAgentControl(db, input("stop"), () => AT)).toBe(true);
    expect(writes.find((write) => write.table === "agent")?.data).toEqual({ stoppedAt: AT });
    expect(writes.find((write) => write.table === "credential")?.data).toEqual({
      revokedAt: AT,
      revokedReason: "agent_stopped",
    });
  });

  test("stopping a stopped Agent writes nothing, and start lifts the stop", async () => {
    const stopped = fakeDb({ hosting: "external", stoppedAt: AT });
    expect(await handleExternalAgentControl(stopped.db, input("stop"))).toBe(true);
    expect(stopped.writes).toEqual([]);
    expect(await handleExternalAgentControl(stopped.db, input("start"))).toBe(true);
    expect(stopped.writes).toEqual([{ table: "agent", data: { stoppedAt: null } }]);
  });

  test.each(["restart", "reset-session", "full-reset", "start"] as const)(
    "%s on a running Agent is refused as having no runtime",
    async (action) => {
      const { db, writes } = fakeDb({ hosting: "external" });
      await expect(handleExternalAgentControl(db, input(action))).rejects.toMatchObject({
        code: "INVALID_INPUT",
        errorId: "agent-external-no-runtime",
      });
      expect(writes).toEqual([]);
    },
  );

  test("a person who neither owns the Agent nor administers the Workspace is refused", async () => {
    const { db, writes } = fakeDb({ hosting: "external" });
    await expect(handleExternalAgentControl(db, input("stop", "stranger"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(writes).toEqual([]);
    const admin = fakeDb({ hosting: "external" }, "admin");
    expect(await handleExternalAgentControl(admin.db, input("stop", "stranger"))).toBe(true);
  });

  test("a deleted Agent is not found", async () => {
    const { db } = fakeDb({ hosting: "external", deletedAt: AT });
    await expect(handleExternalAgentControl(db, input("stop"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
