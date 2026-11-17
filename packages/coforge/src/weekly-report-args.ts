import { unknownCommandError } from "#src/command-help/index";
import { RFC_UUID_PATTERN, WEEKLY_REPORT_SUBJECT_TYPES } from "@lrm/coforge-sdk/internal";
import { type WeeklyReportCollectInvocation } from "#src/weekly-report-collect";
import type { WeeklyReportInvocation } from "../index";
import type { WeeklyReportKeyPointsInvocation } from "../index";
import type { WeeklyReportMemoryInvocation } from "../index";

export function parseWeeklyReportCollectArgs(
  args: readonly string[],
): WeeklyReportCollectInvocation {
  const operation = args[0];
  if (operation !== "submit-pack" && operation !== "submit-empty" && operation !== "submit-failure")
    throw unknownCommandError(["weekly-report-collect", ...args]);
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  const runId = values.get("--run-id");
  const idempotencyKey = values.get("--idempotency-key");
  if (
    !runId ||
    !RFC_UUID_PATTERN.test(runId) ||
    !idempotencyKey ||
    !RFC_UUID_PATTERN.test(idempotencyKey)
  )
    throw new Error("Usage:");
  if (operation === "submit-pack") {
    const markdownPath = values.get("--markdown");
    if (!markdownPath || values.size !== 3) throw new Error("Usage:");
    return {
      command: "weekly-report-collect",
      markdownPath,
      collect: {
        idempotencyKey,
        runId,
        outcome: "ready",
      },
    };
  }
  if (operation === "submit-empty") {
    if (values.size !== 2) throw new Error("Usage:");
    return {
      command: "weekly-report-collect",
      collect: { idempotencyKey, runId, outcome: "empty" },
    };
  }
  const reason = values.get("--reason");
  if (!reason || values.size !== 3) throw new Error("Usage:");
  return {
    command: "weekly-report-collect",
    collect: { idempotencyKey, runId, outcome: "failed", failureReason: reason },
  };
}

export function parseWeeklyReportKeyPointsArgs(
  args: readonly string[],
): WeeklyReportKeyPointsInvocation {
  if (args[0] !== "submit") throw unknownCommandError(["weekly-report-key-points", ...args]);
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  const reportId = values.get("--report-id");
  const idempotencyKey = values.get("--idempotency-key");
  const markdownPath = values.get("--markdown");
  if (
    !reportId ||
    !RFC_UUID_PATTERN.test(reportId) ||
    !idempotencyKey ||
    !RFC_UUID_PATTERN.test(idempotencyKey) ||
    !markdownPath ||
    values.size !== 3
  )
    throw new Error("Usage:");
  return {
    command: "weekly-report-key-points",
    markdownPath,
    keyPoints: { idempotencyKey, reportId, markdown: "" },
  };
}

export function parseWeeklyReportMemoryArgs(args: readonly string[]): WeeklyReportMemoryInvocation {
  if (args[0] !== "submit") throw unknownCommandError(["weekly-report-memory", ...args]);
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  const reportId = values.get("--report-id");
  const idempotencyKey = values.get("--idempotency-key");
  const filePath = values.get("--file");
  if (
    !reportId ||
    !RFC_UUID_PATTERN.test(reportId) ||
    !idempotencyKey ||
    !RFC_UUID_PATTERN.test(idempotencyKey) ||
    !filePath ||
    values.size !== 3
  )
    throw new Error("Usage:");
  return {
    command: "weekly-report-memory",
    filePath,
    memory: { idempotencyKey, reportId },
  };
}

export function parseWeeklyReportArgs(args: readonly string[]): WeeklyReportInvocation {
  const operation = args[0];
  if (operation === "templates" || operation === "inbox" || operation === "members") {
    if (args.length !== 1) throw new Error("Usage:");
    return {
      command: "weekly-report",
      weeklyReport: { operation: "workflow", action: { type: operation } },
    };
  }
  if (operation === "workflow") {
    if (args.length !== 3 || args[1] !== "--input" || !args[2] || args[2].startsWith("--"))
      throw new Error("Usage:");
    return { command: "weekly-report", inputPath: args[2] };
  }
  if (operation !== "context" && operation !== "list" && operation !== "read")
    throw unknownCommandError(["weekly-report", ...args]);
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name))
      throw new Error("Usage:");
    values.set(name, value);
  }
  if (operation === "context") {
    const subjectType = values.get("--subject-type");
    const subjectId = values.get("--subject-id");
    if (
      values.size !== 2 ||
      !WEEKLY_REPORT_SUBJECT_TYPES.includes(
        subjectType as (typeof WEEKLY_REPORT_SUBJECT_TYPES)[number],
      ) ||
      !subjectId ||
      !RFC_UUID_PATTERN.test(subjectId)
    )
      throw new Error("Usage:");
    return {
      command: "weekly-report",
      weeklyReport: {
        operation: "context",
        subjectType: subjectType as (typeof WEEKLY_REPORT_SUBJECT_TYPES)[number],
        subjectId,
      },
    };
  }
  if (operation === "list") {
    const cycleId = values.get("--cycle-id");
    const cursor = values.get("--cursor");
    const limitValue = values.get("--limit");
    for (const name of values.keys()) {
      if (name !== "--cycle-id" && name !== "--cursor" && name !== "--limit")
        throw new Error("Usage:");
    }
    if (cycleId && !RFC_UUID_PATTERN.test(cycleId)) throw new Error("Usage:");
    if (cursor && !RFC_UUID_PATTERN.test(cursor)) throw new Error("Usage:");
    let limit: number | undefined;
    if (limitValue) {
      limit = Number(limitValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Usage:");
    }
    return {
      command: "weekly-report",
      weeklyReport: {
        operation: "list",
        ...(cycleId ? { cycleId } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    };
  }
  const reportId = values.get("--report-id");
  const section = values.get("--section");
  const maxCharactersValue = values.get("--max-characters");
  for (const name of values.keys()) {
    if (name !== "--report-id" && name !== "--section" && name !== "--max-characters")
      throw new Error("Usage:");
  }
  if (!reportId || !RFC_UUID_PATTERN.test(reportId) || !section) throw new Error("Usage:");
  let maxCharacters: number | undefined;
  if (maxCharactersValue) {
    maxCharacters = Number(maxCharactersValue);
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 12_000)
      throw new Error("Usage:");
  }
  return {
    command: "weekly-report",
    weeklyReport: {
      operation: "read",
      reportId,
      section,
      ...(maxCharacters !== undefined ? { maxCharacters } : {}),
    },
  };
}
