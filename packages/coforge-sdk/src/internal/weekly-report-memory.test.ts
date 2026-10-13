import { expect, test } from "bun:test";
import { validateWeeklyReportMemoryCommand } from "./weekly-report-memory";

const identity = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  reportId: "66666666-6666-4666-8666-666666666666",
};

test("memory settlement accepts preferences, an explicit rule, and a thread", () => {
  expect(
    validateWeeklyReportMemoryCommand({
      ...identity,
      year: 2026,
      week: 40,
      preferences: ["先写结果"],
      explicitRules: [{ statement: "以后都先写结果", effect: "adopt" }],
      factCorrections: ["已上线改为还在测试"],
      threads: [{ title: "登录改造", status: "done" }],
    }),
  ).toEqual({
    ...identity,
    year: 2026,
    week: 40,
    preferences: ["先写结果"],
    explicitRules: [{ statement: "以后都先写结果", effect: "adopt" }],
    factCorrections: ["已上线改为还在测试"],
    threads: [{ title: "登录改造", status: "done" }],
  });
});

test("memory settlement rejects a blank preference and an unknown effect", () => {
  expect(
    validateWeeklyReportMemoryCommand({
      ...identity,
      year: 2026,
      week: 40,
      preferences: [" "],
      explicitRules: [],
      factCorrections: [],
      threads: [],
    }),
  ).toBeNull();
  expect(
    validateWeeklyReportMemoryCommand({
      ...identity,
      year: 2026,
      week: 40,
      preferences: [],
      explicitRules: [{ statement: "以后都这样写", effect: "keep" }],
      factCorrections: [],
      threads: [],
    }),
  ).toBeNull();
});
