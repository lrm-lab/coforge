import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { isPrincipalOnCloudComputer } from "#src/server/agents/agent-cloud-computer.server";
import type { WorkspaceAssistantPrincipal } from "#src/server/agents/workspace-assistant-commands.server";
import { resolveDesktopTakeoverPayload } from "#src/server/conversations/action-card-desktop-takeover.server";
import { ActionCardError } from "#src/server/conversations/action-card-error.server";
import { resolvePageFillPayload } from "#src/server/conversations/action-card-page-fill.server";

function stubDb(
  agent: {
    computerId: string | null;
    deletedAt?: Date | null;
    name?: string;
    displayName?: string | null;
    computer?: { kind: string } | null;
  } | null,
  computers: Record<string, { kind: string }> = {},
): PrismaClient {
  return {
    agent: {
      findFirst: async ({ where }: { where?: { deletedAt?: null } } = {}) => {
        if (where && "deletedAt" in where && agent?.deletedAt) return null;
        return agent;
      },
    },
    computer: {
      findUnique: async ({ where }: { where: { id: string } }) => computers[where.id] ?? null,
    },
  } as unknown as PrismaClient;
}

test("isPrincipalOnCloudComputer distinguishes cloud, local, bot, and assistant principals", async () => {
  const db = stubDb(
    { computerId: "computer-local", computer: { kind: "local" } },
    {
      "computer-cloud": { kind: "cloud" },
      "computer-local": { kind: "local" },
    },
  );
  expect(
    await isPrincipalOnCloudComputer(db, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      computerId: "computer-cloud",
    }),
  ).toBe(true);
  expect(
    await isPrincipalOnCloudComputer(db, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      computerId: "computer-local",
    }),
  ).toBe(false);
  expect(
    await isPrincipalOnCloudComputer(db, {
      workspaceId: "ws-1",
      agentId: "agent-1",
      computerId: "",
    }),
  ).toBe(false);

  const assistantPrincipal: WorkspaceAssistantPrincipal = {
    workspaceId: "ws-1",
    agentId: "agent-1",
  };
  expect(await isPrincipalOnCloudComputer(db, assistantPrincipal)).toBe(false);
  const cloudAgentDb = stubDb({ computerId: "computer-cloud", computer: { kind: "cloud" } });
  expect(await isPrincipalOnCloudComputer(cloudAgentDb, assistantPrincipal)).toBe(true);
  const deletedCloudAgentDb = stubDb({
    computerId: "computer-cloud",
    deletedAt: new Date(),
    computer: { kind: "cloud" },
  });
  expect(await isPrincipalOnCloudComputer(deletedCloudAgentDb, assistantPrincipal)).toBe(false);
});

test("resolveDesktopTakeoverPayload and resolvePageFillPayload reject local computers", async () => {
  const localDb = stubDb({
    computerId: "computer-local",
    name: "pm-release",
    displayName: "pm-release",
    computer: { kind: "local" },
  });

  await expect(
    resolveDesktopTakeoverPayload(localDb, "ws-1", "agent-1", {
      type: "desktop:takeover",
      prompt: "Sign in",
    }),
  ).rejects.toEqual(new ActionCardError(422, "INVALID_ACTION", "this agent has no cloud computer"));

  await expect(
    resolvePageFillPayload(localDb, "ws-1", "agent-1", {
      type: "page:fill",
      prompt: "Sign in",
      fields: [{ id: "password", label: "Password", input: "password" }],
    }),
  ).rejects.toEqual(new ActionCardError(422, "INVALID_ACTION", "this agent has no cloud computer"));
});

test("resolveDesktopTakeoverPayload and resolvePageFillPayload accept cloud computers", async () => {
  const cloudDb = stubDb({
    computerId: "computer-cloud",
    name: "cloud-agent",
    displayName: "Cloud Agent",
    computer: { kind: "cloud" },
  });

  await expect(
    resolveDesktopTakeoverPayload(cloudDb, "ws-1", "agent-1", {
      type: "desktop:takeover",
      prompt: "Sign in",
    }),
  ).resolves.toEqual({
    type: "desktop:takeover",
    prompt: "Sign in",
    agentId: "agent-1",
    computerId: "computer-cloud",
    agentName: "Cloud Agent",
  });

  await expect(
    resolvePageFillPayload(cloudDb, "ws-1", "agent-1", {
      type: "page:fill",
      prompt: "Sign in",
      fields: [{ id: "password", label: "Password", input: "password" }],
    }),
  ).resolves.toEqual({
    type: "page:fill",
    prompt: "Sign in",
    agentId: "agent-1",
    computerId: "computer-cloud",
    fields: [{ id: "password", label: "Password", input: "password" }],
  });
});
