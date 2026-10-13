import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { RecordCatalog } from "#src/server/records/record-catalog.server";

import {
  applyMemorySettlement,
  buildWeeklyReportMemoryWakeText,
  emptyWeeklyReportMemory,
  memoryForPrompt,
  replaceWeeklyReportMemoryWeek,
  WEEKLY_REPORT_MEMORY_SETTLED_NOTE,
  WEEKLY_REPORT_MEMORY_SETTLING_NOTE,
} from "#src/server/records/weekly-report-memory.server";
import {
  applyWeeklyReportMemoryWriteBack,
  finishWeeklyReportMemorySettlementNote,
  recordWeeklyReportMemorySettlementNote,
  startWeeklyReportMemorySettlement,
} from "#src/server/records/weekly-report-memory-settlement.server";

const week = (weekNumber: number) => ({ year: 2026, week: weekNumber });

test("one preference stays an observation and a repeated week promotes it", () => {
  const once = applyMemorySettlement(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: ["写解决了什么问题，少写提交次数"],
    explicitRules: [],
    factCorrections: ["已上线改为还在测试"],
    threads: [],
  });
  expect(memoryForPrompt(once)).toEqual({ writingHabits: [], openThreads: [] });
  expect(once.observations).toEqual([
    { statement: "写解决了什么问题，少写提交次数", weeks: [{ year: 2026, week: 40 }] },
  ]);
  expect(once.habits).toEqual([]);

  const sameWeek = applyMemorySettlement(once, {
    ...week(40),
    preferences: ["写解决了什么问题，少写提交次数"],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(sameWeek.habits).toEqual([]);

  const promoted = applyMemorySettlement(sameWeek, {
    ...week(41),
    preferences: ["  写解决了什么问题，少写提交次数  "],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(memoryForPrompt(promoted).writingHabits).toEqual(["写解决了什么问题，少写提交次数"]);
});

test("a repeated preference becomes one habit and drops the observation copy", () => {
  const once = applyMemorySettlement(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: ["先写结果"],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  const promoted = applyMemorySettlement(once, {
    ...week(41),
    preferences: ["先写结果"],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(promoted.habits).toEqual([{ statement: "先写结果", status: "active" }]);
  expect(promoted.observations).toEqual([]);

  const again = applyMemorySettlement(promoted, {
    ...week(42),
    preferences: ["  先写结果  "],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(again.habits).toEqual([{ statement: "先写结果", status: "active" }]);
  expect(again.observations).toEqual([]);
});

test("a preference does not revive a retired habit", () => {
  const adopted = applyMemorySettlement(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: [],
    explicitRules: [{ statement: "先写结果", effect: "adopt" }],
    factCorrections: [],
    threads: [],
  });
  const retired = applyMemorySettlement(adopted, {
    ...week(41),
    preferences: [],
    explicitRules: [{ statement: "先写结果", effect: "retire" }],
    factCorrections: [],
    threads: [],
  });
  const repeated = applyMemorySettlement(retired, {
    ...week(42),
    preferences: ["先写结果"],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(repeated.habits).toEqual([{ statement: "先写结果", status: "retired" }]);
  expect(repeated.observations).toEqual([]);
  expect(memoryForPrompt(repeated).writingHabits).toEqual([]);
});

test("an explicit rule is adopted or retired immediately", () => {
  const adopted = applyMemorySettlement(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: [],
    explicitRules: [{ statement: "先写结果", effect: "adopt" }],
    factCorrections: [],
    threads: [],
  });
  expect(memoryForPrompt(adopted).writingHabits).toEqual(["先写结果"]);

  const retired = applyMemorySettlement(adopted, {
    ...week(41),
    preferences: [],
    explicitRules: [{ statement: "先写结果", effect: "retire" }],
    factCorrections: [],
    threads: [],
  });
  expect(memoryForPrompt(retired).writingHabits).toEqual([]);
  expect(retired.habits).toEqual([{ statement: "先写结果", status: "retired" }]);
});

test("a finished thread stays through the next submission, then drops after two quiet ones", () => {
  let memory = applyMemorySettlement(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [{ title: "采集服务", status: "open" }],
  });
  expect(memoryForPrompt(memory).openThreads).toEqual([{ title: "采集服务", status: "open" }]);

  memory = applyMemorySettlement(memory, {
    ...week(41),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [{ title: "采集服务", status: "done" }],
  });
  expect(memoryForPrompt(memory).openThreads).toEqual([{ title: "采集服务", status: "done" }]);

  const quiet = (weekNumber: number) =>
    applyMemorySettlement(memory, {
      ...week(weekNumber),
      preferences: [],
      explicitRules: [],
      factCorrections: [],
      threads: [],
    });

  memory = quiet(42);
  expect(memoryForPrompt(memory).openThreads).toEqual([{ title: "采集服务", status: "done" }]);
  memory = quiet(43);
  expect(memoryForPrompt(memory).openThreads).toEqual([{ title: "采集服务", status: "done" }]);
  memory = quiet(44);
  expect(memoryForPrompt(memory).openThreads).toEqual([]);
});

test("the settlement wake includes the assistant original, the final body, and an explicit rule", () => {
  const body = buildWeeklyReportMemoryWakeText({
    reportId: "22222222-2222-4222-8222-222222222222",
    year: 2026,
    week: 40,
    draftMarkdown: "本周提交了 8 次代码。",
    finalMarkdown: "本周解决了登录超时。",
    userLines: ["以后都这样写"],
  });
  expect(body).toContain("本周提交了 8 次代码。");
  expect(body).toContain("本周解决了登录超时。");
  expect(body).toContain("以后都这样写");
  expect(body).toContain("weekly-report-memory submit");
});

test("the settlement wake names habits the assistant must reuse", () => {
  const body = buildWeeklyReportMemoryWakeText({
    reportId: "22222222-2222-4222-8222-222222222222",
    year: 2026,
    week: 41,
    draftMarkdown: "",
    finalMarkdown: "本周解决了登录超时。",
    userLines: [],
    writingHabits: ["先写结果"],
  });
  expect(body).toContain("先写结果");
  expect(body).toContain("沿用原句");
});

test("the first submitted member report wakes memory settlement", async () => {
  const wakes: string[] = [];
  const result = await startWeeklyReportMemorySettlement(
    {
      weeklyReport: {
        findFirst: async () => ({
          id: "22222222-2222-4222-8222-222222222222",
          authorId: "user-1",
          status: "submitted",
          content: {
            tabs: { Progress: { markdown: "本周解决了登录超时。" } },
            assistantDraft: { tabs: { Progress: { markdown: "本周提交了 8 次代码。" } } },
          },
          cycle: { year: 2026, week: 40 },
        }),
      },
      weeklyReportAssistant: {
        findUnique: async () => ({
          agentId: "agent-1",
          memory: {
            version: 1,
            habits: [{ statement: "先写结果", status: "active" }],
            observations: [],
            threads: [],
            settlements: [],
          },
        }),
      },
    } as never,
    {
      workspaceId: "workspace-1",
      reportId: "22222222-2222-4222-8222-222222222222",
      userLines: ["以后都这样写"],
      wake: async (body) => {
        wakes.push(body);
      },
    },
  );
  expect(result.started).toBe(true);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toContain("以后都这样写");
  expect(wakes[0]).toContain("先写结果");
});

test("memory write-back stores an explicit habit for the report author", async () => {
  let memory: unknown = null;
  await applyWeeklyReportMemoryWriteBack(
    {
      weeklyReport: {
        findFirst: async () => ({ authorId: "user-1" }),
      },
      weeklyReportAssistant: {
        findFirst: async () => ({ id: "assistant-1", memory: null }),
        update: async (query: { data: { memory: unknown } }) => {
          memory = query.data.memory;
          return query.data;
        },
      },
      recordComment: {
        findFirst: async () => null,
      },
    } as never,
    {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      reportId: "22222222-2222-4222-8222-222222222222",
      settlement: {
        year: 2026,
        week: 40,
        preferences: [],
        explicitRules: [{ statement: "先写结果", effect: "adopt" }],
        factCorrections: ["已上线改为还在测试"],
        threads: [{ title: "采集服务", status: "open" }],
      },
    },
  );
  expect(
    memoryForPrompt(memory as ReturnType<typeof emptyWeeklyReportMemory>).writingHabits,
  ).toEqual(["先写结果"]);
  expect(memoryForPrompt(memory as ReturnType<typeof emptyWeeklyReportMemory>).openThreads).toEqual(
    [{ title: "采集服务", status: "open" }],
  );
});

test("a second write-back for the same week replaces the first settlement", async () => {
  let memory: unknown = null;
  const db = {
    weeklyReport: {
      findFirst: async () => ({ authorId: "user-1" }),
    },
    weeklyReportAssistant: {
      findFirst: async () => ({ id: "assistant-1", memory }),
      update: async (query: { data: { memory: unknown } }) => {
        memory = query.data.memory;
        return query.data;
      },
    },
    recordComment: {
      findFirst: async () => null,
    },
  } as never;
  const base = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    reportId: "22222222-2222-4222-8222-222222222222",
  };
  await applyWeeklyReportMemoryWriteBack(db, {
    ...base,
    settlement: {
      year: 2026,
      week: 40,
      preferences: ["先写过程"],
      explicitRules: [],
      factCorrections: [],
      threads: [{ title: "旧事项", status: "open" }],
    },
  });
  await applyWeeklyReportMemoryWriteBack(db, {
    ...base,
    settlement: {
      year: 2026,
      week: 40,
      preferences: ["先写结果"],
      explicitRules: [],
      factCorrections: [],
      threads: [{ title: "新事项", status: "open" }],
    },
  });
  const stored = memory as ReturnType<typeof emptyWeeklyReportMemory>;
  expect(stored.observations.map((item) => item.statement)).toEqual(["先写结果"]);
  expect(memoryForPrompt(stored).openThreads).toEqual([{ title: "新事项", status: "open" }]);
});

test("settlement notes move from waiting to recorded", async () => {
  const comments: Array<{ id: string; body: string; createdAt: string }> = [];
  const db = {
    recordComment: {
      create: async (query: { data: { body: string } }) => {
        const row = {
          id: `comment-${comments.length + 1}`,
          body: query.data.body,
          createdAt: new Date(Date.now() + comments.length).toISOString(),
        };
        comments.push(row);
        return row;
      },
      findFirst: async (query: { where: { body: string } }) =>
        [...comments].reverse().find((row) => row.body === query.where.body) ?? null,
      update: async (query: { where: { id: string }; data: { body: string } }) => {
        const row = comments.find((item) => item.id === query.where.id);
        if (row) row.body = query.data.body;
        return row;
      },
    },
  } as never;
  await recordWeeklyReportMemorySettlementNote(db, {
    workspaceId: "workspace-1",
    reportId: "22222222-2222-4222-8222-222222222222",
    assistantSessionId: "33333333-3333-4333-8333-333333333333",
  });
  expect(comments.map((row) => row.body)).toEqual([WEEKLY_REPORT_MEMORY_SETTLING_NOTE]);
  await finishWeeklyReportMemorySettlementNote(db, {
    workspaceId: "workspace-1",
    reportId: "22222222-2222-4222-8222-222222222222",
  });
  expect(comments.map((row) => row.body)).toEqual([WEEKLY_REPORT_MEMORY_SETTLED_NOTE]);
  await finishWeeklyReportMemorySettlementNote(db, {
    workspaceId: "workspace-1",
    reportId: "22222222-2222-4222-8222-222222222222",
  });
  expect(comments).toHaveLength(1);
});

test("a later settlement for the same week replaces that week", () => {
  const first = replaceWeeklyReportMemoryWeek(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: ["先写过程"],
    explicitRules: [],
    factCorrections: [],
    threads: [{ title: "旧事项", status: "open" }],
  });
  const replaced = replaceWeeklyReportMemoryWeek(first, {
    ...week(40),
    preferences: ["先写结果"],
    explicitRules: [],
    factCorrections: [],
    threads: [{ title: "新事项", status: "open" }],
  });
  expect(replaced.observations.map((item) => item.statement)).toEqual(["先写结果"]);
  expect(memoryForPrompt(replaced).openThreads).toEqual([{ title: "新事项", status: "open" }]);

  const aged = replaceWeeklyReportMemoryWeek(replaced, {
    ...week(41),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  const rewritten = replaceWeeklyReportMemoryWeek(aged, {
    ...week(40),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [{ title: "采集服务", status: "done" }],
  });
  expect(memoryForPrompt(rewritten).openThreads).toEqual([{ title: "采集服务", status: "done" }]);
  expect(rewritten.observations).toEqual([]);
});

test("resending a member report settles memory again and does not extract key points", async () => {
  const calls: string[] = [];
  const reportId = "22222222-2222-4222-8222-222222222222";
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReport: {
      findFirst: async (query: {
        select?: { sourceTemplate?: unknown; submissions?: unknown };
      }) => {
        calls.push(
          query.select?.sourceTemplate
            ? "key-points"
            : query.select?.submissions
              ? "save"
              : "memory",
        );
        return {
          id: reportId,
          authorId: "user-1",
          kind: "member",
          status: "submitted",
          hiddenFromAuthor: false,
          settingsId: null,
          content: { tabs: { Progress: { markdown: "改过的正文" } } },
          cycle: { year: 2026, week: 40 },
          submissions: [],
        };
      },
      update: async () => ({
        id: reportId,
        status: "submitted",
        updatedAt: new Date("2026-10-12T02:00:00.000Z"),
      }),
    },
    weeklyReportAssistant: {
      findUnique: async () => {
        calls.push("memory-assistant");
        return null;
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).saveReportContent({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId,
    content: { tabs: { Progress: { markdown: "改过的正文" } } },
    status: "submitted",
  });

  expect(calls).toContain("memory-assistant");
  expect(calls).not.toContain("key-points");
});

test("an open thread drops after two submissions that do not mention it", () => {
  let memory = applyMemorySettlement(emptyWeeklyReportMemory(), {
    ...week(40),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [{ title: "登录超时", status: "open" }],
  });
  memory = applyMemorySettlement(memory, {
    ...week(41),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(memoryForPrompt(memory).openThreads).toEqual([{ title: "登录超时", status: "open" }]);
  memory = applyMemorySettlement(memory, {
    ...week(42),
    preferences: [],
    explicitRules: [],
    factCorrections: [],
    threads: [],
  });
  expect(memoryForPrompt(memory).openThreads).toEqual([]);
});
