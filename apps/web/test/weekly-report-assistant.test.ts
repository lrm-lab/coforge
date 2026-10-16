import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { RecordCatalog } from "#src/server/records/record-catalog.server";
import {
  WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
  ensureWeeklyReportAssistant,
  userOwnsLiveComputer,
  weeklyReportAssistantAgentName,
  weeklyReportAssistantDisplayName,
} from "#src/server/records/weekly-report-assistant.server";

test("weekly report assistants are named after their owner and keep a User-scoped Agent identity", () => {
  expect(WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME).toBe("周报助手");
  expect(weeklyReportAssistantDisplayName("李健")).toBe("李健的周报助手");
  expect(weeklyReportAssistantDisplayName("  李健  ")).toBe("李健的周报助手");
  expect(weeklyReportAssistantAgentName("user-a")).toBe("weekly-report-assistant-user-a");
  expect(weeklyReportAssistantAgentName("user-b")).not.toBe(
    weeklyReportAssistantAgentName("user-a"),
  );
});

test("assistant context manifests expose structure without report bodies", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "workspace-1",
        cycleId: "cycle-1",
        authorId: "user-1",
        sourceTemplateId: null,
        kind: "member",
        title: "Alice 2026 W38",
        status: "submitted",
        content: {
          tabs: {
            Progress: { markdown: "private body must not escape" },
            Plans: { markdown: "next" },
          },
        },
        submittedAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
        sourceTemplate: null,
        settingsId: null,
      }),
      count: async () => 0,
      findMany: async () => [],
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
    weeklyReportTemplate: {
      findMany: async () => [],
    },
    weeklyReportAssistant: {
      findUnique: async () => ({
        memory: {
          version: 1,
          habits: [{ statement: "先写结果", status: "active" }],
          observations: [],
          threads: [{ title: "采集服务", status: "open", quiet: 0, carry: false }],
        },
      }),
    },
  } as unknown as PrismaClient;

  const manifest = await new RecordCatalog(db).loadAssistantContextManifest({
    workspaceId: "workspace-1",
    userId: "user-1",
    subjectType: "report",
    subjectId: "report-1",
  });

  expect(manifest).toEqual({
    subjectType: "report",
    subjectId: "report-1",
    cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
    kind: "member",
    status: "submitted",
    structure: ["Progress", "Plans"],
    availableData: [
      "current_report",
      "template",
      "submission_status",
      "visible_member_reports",
      "favorites",
    ],
    templateFormats: [],
    templateFormatsNextCursor: null,
    contextVersion: "2026-09-18T00:00:00.000Z",
    writingHabits: ["先写结果"],
    openThreads: [{ title: "采集服务", status: "open" }],
  });
  expect(JSON.stringify(manifest)).not.toContain("private body");
});

test("assistant report lists are visible-only and cursor bounded", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findMany: async (query: { take: number }) =>
        Array.from({ length: query.take }, (_, index) => ({
          id: `report-${index}`,
          cycleId: "cycle-1",
          authorId: "user-2",
          title: `Report ${index}`,
          status: "submitted",
          submittedAt: new Date("2026-09-18T00:00:00.000Z"),
          updatedAt: new Date(`2026-09-${18 - index}T00:00:00.000Z`),
          author: { username: "alice", displayName: "Alice" },
          cycle: { year: 2026, week: 38, title: "2026 W38" },
        })),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).listAssistantVisibleReports({
    workspaceId: "workspace-1",
    userId: "user-1",
    limit: 2,
  });

  expect(result.reports).toHaveLength(2);
  expect(result.reports[0]).toMatchObject({
    id: "report-0",
    author: { displayName: "Alice" },
    source: { kind: "weekly_report", reportId: "report-0", userId: "user-2" },
  });
  expect(result.nextCursor).toBe("report-1");
});

test("assistant report reads are section-scoped, bounded, and source-backed", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "workspace-1",
        cycleId: "cycle-1",
        authorId: "user-1",
        sourceTemplateId: null,
        kind: "member",
        title: "Alice 2026 W38",
        status: "submitted",
        content: {
          tabs: {
            Summary: { markdown: "0123456789ABCDEFGHIJ" },
          },
        },
        submittedAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
        sourceTemplate: null,
      }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).readAssistantReportSection({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId: "report-1",
    section: "Summary",
    maxCharacters: 10,
  });

  expect(result).toEqual({
    reportId: "report-1",
    section: "Summary",
    markdown: "0123456789",
    truncated: true,
    source: {
      kind: "weekly_report",
      reportId: "report-1",
      userId: "user-1",
      displayName: "Alice",
      cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
    },
  });
});

test("ensureWeeklyReportAssistant creates one assistant per User in a Workspace", async () => {
  const assistants: Array<{
    id: string;
    workspaceId: string;
    userId: string;
    agentId: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const agents: Array<Record<string, unknown>> = [];
  let agentSequence = 0;
  const users: Record<string, { username: string; displayName: string }> = {
    "user-1": { username: "lijian", displayName: "李健" },
    "user-2": { username: "ada", displayName: "Ada Lovelace" },
  };
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null,
    },
    weeklyReportAssistant: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
      }) =>
        assistants.find(
          (assistant) =>
            assistant.workspaceId === where.workspaceId_userId.workspaceId &&
            assistant.userId === where.workspaceId_userId.userId,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: { workspaceId: string; userId: string; agentId: string };
      }) => {
        const record = {
          id: `assistant-${assistants.length + 1}`,
          workspaceId: data.workspaceId,
          userId: data.userId,
          agentId: data.agentId,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        assistants.push(record);
        return record;
      },
    },
    agent: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_name: { workspaceId: string; name: string } };
      }) => {
        const agent = agents.find(
          (row) =>
            row.workspaceId === where.workspaceId_name.workspaceId &&
            row.name === where.workspaceId_name.name,
        );
        return agent
          ? {
              id: agent.id as string,
              ownerId: agent.ownerId as string,
              deletedAt: (agent.deletedAt as Date | null | undefined) ?? null,
            }
          : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const agent = { ...data, id: `agent-${++agentSequence}`, deletedAt: null };
        agents.push(agent);
        return agent;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id_workspaceId: { id: string; workspaceId: string } };
        data: Record<string, unknown>;
      }) => {
        const agent = agents.find((row) => row.id === where.id_workspaceId.id);
        if (!agent) throw new Error("missing agent");
        Object.assign(agent, data);
        return agent;
      },
      findMany: async () => agents.map((agent) => ({ id: agent.id })),
    },
    conversation: {
      createMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ id: "general-1" }),
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    conversationMember: {
      createMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async () => undefined,
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  };

  const first = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
  });
  const second = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
  });
  const otherUser = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-2",
  });

  expect(second).toBe(first);
  expect(otherUser.agentId).not.toBe(first.agentId);
  expect(agents).toHaveLength(2);
  expect(agents[0]).toMatchObject({
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: weeklyReportAssistantAgentName("user-1"),
    displayName: "李健的周报助手",
    visibility: "private",
    runtimeConfig: {
      runtime: "coforge",
      provider: { kind: "default" },
    },
  });
  expect(agents[1]).toMatchObject({ displayName: "Ada Lovelace的周报助手" });

  agents[0]!.displayName = WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME;
  await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
  });
  expect(agents[0]!.displayName).toBe("李健的周报助手");
});

test("ensureWeeklyReportAssistant reclaims an orphan Agent left without an assistant row", async () => {
  const agentName = weeklyReportAssistantAgentName("user-1");
  const assistants: Array<{
    id: string;
    workspaceId: string;
    userId: string;
    agentId: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const agents: Array<Record<string, unknown>> = [
    {
      id: "orphan-agent",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      name: agentName,
      deletedAt: null,
      visibility: "public",
    },
  ];
  let createdAgents = 0;
  const tx = {
    weeklyReportAssistant: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
      }) =>
        assistants.find(
          (assistant) =>
            assistant.workspaceId === where.workspaceId_userId.workspaceId &&
            assistant.userId === where.workspaceId_userId.userId,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: { workspaceId: string; userId: string; agentId: string };
      }) => {
        const record = {
          id: "assistant-1",
          workspaceId: data.workspaceId,
          userId: data.userId,
          agentId: data.agentId,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        assistants.push(record);
        return record;
      },
    },
    agent: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_name: { workspaceId: string; name: string } };
      }) => {
        const agent = agents.find(
          (row) =>
            row.workspaceId === where.workspaceId_name.workspaceId &&
            row.name === where.workspaceId_name.name,
        );
        return agent
          ? {
              id: agent.id as string,
              ownerId: agent.ownerId as string,
              deletedAt: (agent.deletedAt as Date | null | undefined) ?? null,
              visibility: (agent.visibility as string | undefined) ?? "public",
            }
          : null;
      },
      create: async () => {
        createdAgents += 1;
        throw new Error("must not create a second Agent for the same assistant name");
      },
      update: async ({
        where,
        data,
      }: {
        where: { id_workspaceId: { id: string; workspaceId: string } };
        data: Record<string, unknown>;
      }) => {
        const agent = agents.find((row) => row.id === where.id_workspaceId.id);
        if (!agent) throw new Error("missing agent");
        Object.assign(agent, data);
        return agent;
      },
      findMany: async () => agents.map((agent) => ({ id: agent.id })),
    },
    conversation: {
      createMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ id: "general-1" }),
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    conversationMember: {
      createMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async () => undefined,
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
    weeklyReportAssistant: tx.weeklyReportAssistant,
  };

  const row = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
  });

  expect(row.agentId).toBe("orphan-agent");
  expect(createdAgents).toBe(0);
  expect(assistants).toHaveLength(1);
  expect(agents[0]).toMatchObject({ visibility: "private" });
});

test("a new weekly-report assistant binds only to the owner's default cloud computer and uses Pi's default model", async () => {
  const agents: Array<Record<string, unknown>> = [];
  const computers = [
    {
      id: "cloud-1",
      ownerId: "user-1",
      kind: "cloud",
      cloudSlot: "default",
      deletedAt: null,
    },
    {
      id: "cloud-other",
      ownerId: "user-2",
      kind: "cloud",
      cloudSlot: "default",
      deletedAt: null,
    },
  ];
  const tx = {
    user: {
      findUnique: async () => ({ username: "lijian", displayName: "李健" }),
    },
    computer: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; ownerId: string; deletedAt: null; kind: string; cloudSlot: string };
      }) =>
        computers.find(
          (computer) =>
            computer.id === where.id &&
            computer.ownerId === where.ownerId &&
            computer.deletedAt === where.deletedAt &&
            computer.kind === where.kind &&
            computer.cloudSlot === where.cloudSlot,
        ) ?? null,
    },
    weeklyReportAssistant: {
      findUnique: async () => null,
      create: async ({
        data,
      }: {
        data: { workspaceId: string; userId: string; agentId: string };
      }) => ({
        id: "assistant-1",
        ...data,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    },
    agent: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const agent = { ...data, id: `agent-${agents.length + 1}` };
        agents.push(agent);
        return agent;
      },
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
    weeklyReportAssistant: { findUnique: async () => null },
  };

  await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
    computerId: "cloud-1",
  });
  await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-2",
    userId: "user-1",
    computerId: "cloud-other",
  });

  expect(agents[0]).toMatchObject({
    computerId: "cloud-1",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
  });
  expect(agents[1]).toMatchObject({
    runtimeConfig: { runtime: "coforge", provider: { kind: "default" } },
  });
  expect(agents[1]).not.toHaveProperty("computerId");
});

test("ensuring an assistant leaves a computer the user already chose", async () => {
  const agents = [
    {
      id: "agent-1",
      workspaceId: "workspace-1",
      ownerId: "user-1",
      name: weeklyReportAssistantAgentName("user-1"),
      displayName: "李健的周报助手",
      computerId: "local-1",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "chosen",
        modelProvider: "",
        reasoning: "",
      },
    },
  ];
  const tx = {
    user: {
      findUnique: async () => ({ username: "lijian", displayName: "李健" }),
    },
    computer: {
      findFirst: async () => {
        throw new Error("must not look up a computer for an assistant that already has one");
      },
    },
    weeklyReportAssistant: {
      findUnique: async () => ({
        id: "assistant-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        agentId: "agent-1",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    },
    agent: {
      findUnique: async () => agents[0],
      update: async () => {
        throw new Error("must not rewrite an assistant that already has a computer");
      },
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  };

  await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
    computerId: "cloud-1",
  });

  expect(agents[0]?.computerId).toBe("local-1");
  expect(agents[0]?.runtimeConfig).toMatchObject({ model: "chosen" });
});

test("a weekly-report assistant can use the owner's other computers, not someone else's", async () => {
  const computers = [
    { id: "extra-1", ownerId: "user-1", deletedAt: null },
    { id: "local-1", ownerId: "user-1", deletedAt: null },
    { id: "gone-1", ownerId: "user-1", deletedAt: new Date(0) },
    { id: "theirs-1", ownerId: "user-2", deletedAt: null },
  ];
  const db = {
    computer: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string; deletedAt: null } }) =>
        computers.find(
          (computer) =>
            computer.id === where.id &&
            computer.ownerId === where.ownerId &&
            computer.deletedAt === where.deletedAt,
        ) ?? null,
    },
  };

  expect(await userOwnsLiveComputer(db as never, { userId: "user-1", computerId: "extra-1" })).toBe(
    true,
  );
  expect(await userOwnsLiveComputer(db as never, { userId: "user-1", computerId: "local-1" })).toBe(
    true,
  );
  expect(await userOwnsLiveComputer(db as never, { userId: "user-1", computerId: "gone-1" })).toBe(
    false,
  );
  expect(
    await userOwnsLiveComputer(db as never, { userId: "user-1", computerId: "theirs-1" }),
  ).toBe(false);
});
