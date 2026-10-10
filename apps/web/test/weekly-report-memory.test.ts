import { expect, test } from "bun:test";

import {
  applyMemorySettlement,
  buildWeeklyReportMemoryWakeText,
  emptyWeeklyReportMemory,
  memoryForPrompt,
} from "#src/server/records/weekly-report-memory.server";
import {
  applyWeeklyReportMemoryWriteBack,
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
        findUnique: async () => ({ agentId: "agent-1" }),
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
