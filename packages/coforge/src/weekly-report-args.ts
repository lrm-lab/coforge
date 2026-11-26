import { unknownCommandError } from "#src/command-help/index";
import { RFC_UUID_PATTERN, WEEKLY_REPORT_SUBJECT_TYPES } from "@lrm/coforge-sdk/internal";
import { type WeeklyReportCollectInvocation } from "#src/weekly-report-collect";
import type { WeeklyReportInvocation } from "../index";
import type { WeeklyReportKeyPointsInvocation } from "../index";
import type { WeeklyReportMemoryInvocation } from "../index";
import { parseCliFlags, type CliFlagOptions } from "./cli-flags";

function parseStrictFlags<const Keys extends readonly string[]>(
  args: readonly string[],
  keys: Keys,
): Partial<Record<Keys[number], string>> {
  const options: CliFlagOptions = {};
  for (const key of keys) options[key] = { type: "string" };
  const { values } = parseCliFlags({
    args,
    options,
    allowEmptyValues: false,
    rejectFlagValues: true,
    duplicates: "error-strings",
    onError() {
      throw new Error("Usage:");
    },
  });
  return values as Partial<Record<Keys[number], string>>;
}

export function parseWeeklyReportCollectArgs(
  args: readonly string[],
): WeeklyReportCollectInvocation {
  const operation = args[0];
  if (operation !== "submit-pack" && operation !== "submit-empty" && operation !== "submit-failure")
    throw unknownCommandError(["weekly-report-collect", ...args]);
  const allowed =
    operation === "submit-pack"
      ? (["run-id", "idempotency-key", "markdown"] as const)
      : operation === "submit-empty"
        ? (["run-id", "idempotency-key"] as const)
        : (["run-id", "idempotency-key", "reason"] as const);
  const values = parseStrictFlags(args.slice(1), allowed);
  const runId = values["run-id"];
  const idempotencyKey = values["idempotency-key"];
  if (
    !runId ||
    !RFC_UUID_PATTERN.test(runId) ||
    !idempotencyKey ||
    !RFC_UUID_PATTERN.test(idempotencyKey)
  )
    throw new Error("Usage:");
  if (operation === "submit-pack") {
    const markdownPath = values.markdown;
    if (!markdownPath) throw new Error("Usage:");
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
    return {
      command: "weekly-report-collect",
      collect: { idempotencyKey, runId, outcome: "empty" },
    };
  }
  const reason = values.reason;
  if (!reason) throw new Error("Usage:");
  return {
    command: "weekly-report-collect",
    collect: { idempotencyKey, runId, outcome: "failed", failureReason: reason },
  };
}

export function parseWeeklyReportKeyPointsArgs(
  args: readonly string[],
): WeeklyReportKeyPointsInvocation {
  if (args[0] !== "submit") throw unknownCommandError(["weekly-report-key-points", ...args]);
  const values = parseStrictFlags(args.slice(1), [
    "report-id",
    "idempotency-key",
    "markdown",
  ] as const);
  const reportId = values["report-id"];
  const idempotencyKey = values["idempotency-key"];
  const markdownPath = values.markdown;
  if (
    !reportId ||
    !RFC_UUID_PATTERN.test(reportId) ||
    !idempotencyKey ||
    !RFC_UUID_PATTERN.test(idempotencyKey) ||
    !markdownPath
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
  const values = parseStrictFlags(args.slice(1), ["report-id", "idempotency-key", "file"] as const);
  const reportId = values["report-id"];
  const idempotencyKey = values["idempotency-key"];
  const filePath = values.file;
  if (
    !reportId ||
    !RFC_UUID_PATTERN.test(reportId) ||
    !idempotencyKey ||
    !RFC_UUID_PATTERN.test(idempotencyKey) ||
    !filePath
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
    const values = parseStrictFlags(args.slice(1), ["input"] as const);
    if (!values.input) throw new Error("Usage:");
    return { command: "weekly-report", inputPath: values.input };
  }
  if (operation === "context") {
    const values = parseStrictFlags(args.slice(1), ["subject-type", "subject-id"] as const);
    const subjectType = values["subject-type"];
    const subjectId = values["subject-id"];
    if (
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
    const values = parseStrictFlags(args.slice(1), ["cycle-id", "cursor", "limit"] as const);
    const cycleId = values["cycle-id"];
    const cursor = values.cursor;
    const limitValue = values.limit;
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
  if (operation !== "read") throw unknownCommandError(["weekly-report", ...args]);
  const values = parseStrictFlags(args.slice(1), [
    "report-id",
    "section",
    "max-characters",
  ] as const);
  const reportId = values["report-id"];
  const section = values.section;
  const maxCharactersValue = values["max-characters"];
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
