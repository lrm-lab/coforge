import { z } from "zod";
import {
  weeklyReportWorkflowSchema,
  type WeeklyReportWorkflowAction,
} from "./weekly-report-workflow";
import { RPC_METHODS } from "./rpc-methods";
import { RFC_UUID_PATTERN } from "./uuid";
import { utf8Encoder, utf8Decoder } from "./text-codec";
/** Agent HTTPS weekly-report reads. Authorization is the assistant owner User. */
export const AGENT_WEEKLY_REPORT_METHOD = RPC_METHODS.agentWeeklyReport;

export const WEEKLY_REPORT_SUBJECT_TYPES = ["report", "cycle"] as const;
export type WeeklyReportSubjectType = (typeof WEEKLY_REPORT_SUBJECT_TYPES)[number];

export type WeeklyReportCommand =
  | { operation: "workflow"; action: WeeklyReportWorkflowAction }
  | {
      operation: "context";
      subjectType: WeeklyReportSubjectType;
      subjectId: string;
    }
  | {
      operation: "list";
      cycleId?: string;
      cursor?: string;
      limit?: number;
    }
  | {
      operation: "read";
      reportId: string;
      section: string;
      maxCharacters?: number;
    };

export type WeeklyReportRequest = WeeklyReportCommand & {
  idempotencyKey: string;
  workspaceId: string;
  agentId: string;
};

export type WeeklyReportResponse = {
  idempotencyKey: string;
  operation: WeeklyReportCommand["operation"];
  result: unknown;
};

const nonblankStringSchema = z.string().refine((value) => value.trim().length > 0);
const uuidStringSchema = z.string().regex(RFC_UUID_PATTERN);

const weeklyReportIdentityShape = {
  idempotencyKey: nonblankStringSchema,
  workspaceId: nonblankStringSchema,
  agentId: nonblankStringSchema,
};

const weeklyReportIdentitySchema = z.object(weeklyReportIdentityShape);

const weeklyReportWorkflowRequestSchema = z.object({
  ...weeklyReportIdentityShape,
  operation: z.literal("workflow"),
  action: weeklyReportWorkflowSchema,
});

const weeklyReportNonWorkflowRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    ...weeklyReportIdentityShape,
    operation: z.literal("context"),
    subjectType: z.enum(WEEKLY_REPORT_SUBJECT_TYPES),
    subjectId: uuidStringSchema,
  }),
  z.object({
    ...weeklyReportIdentityShape,
    operation: z.literal("list"),
    cycleId: uuidStringSchema.optional(),
    cursor: uuidStringSchema.optional(),
    limit: z.int().min(1).max(50).optional(),
  }),
  z.object({
    ...weeklyReportIdentityShape,
    operation: z.literal("read"),
    reportId: uuidStringSchema,
    section: nonblankStringSchema.max(100).transform((value) => value.trim()),
    maxCharacters: z.int().min(1).max(12_000).optional(),
  }),
]);

const weeklyReportResponseSchema = z.object({
  idempotencyKey: nonblankStringSchema,
  operation: z.enum(["context", "list", "read", "workflow"]),
  result: z.unknown().optional(),
});

export function validateWeeklyReportRequest(value: unknown): WeeklyReportRequest {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { operation?: unknown }).operation === "workflow"
  ) {
    const header = weeklyReportIdentitySchema.safeParse(value);
    if (!header.success) throw new Error("invalid weekly-report request");
    return weeklyReportWorkflowRequestSchema.parse(value);
  }
  const parsed = weeklyReportNonWorkflowRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid weekly-report request");
  const request = parsed.data;
  if (request.operation === "list") {
    return {
      idempotencyKey: request.idempotencyKey,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      operation: "list",
      ...(request.cycleId ? { cycleId: request.cycleId } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    };
  }
  if (request.operation === "read") {
    return {
      idempotencyKey: request.idempotencyKey,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      operation: "read",
      reportId: request.reportId,
      section: request.section,
      ...(request.maxCharacters !== undefined ? { maxCharacters: request.maxCharacters } : {}),
    };
  }
  return request;
}

export function encodeWeeklyReportRequest(request: WeeklyReportRequest): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(validateWeeklyReportRequest(request)));
}

export function decodeWeeklyReportRequest(bytes: Uint8Array): WeeklyReportRequest {
  try {
    return validateWeeklyReportRequest(JSON.parse(utf8Decoder.decode(bytes)));
  } catch {
    throw new Error("invalid weekly-report request");
  }
}

export function encodeWeeklyReportResponse(response: WeeklyReportResponse): Uint8Array {
  const parsed = weeklyReportResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("invalid weekly-report response");
  return utf8Encoder.encode(
    JSON.stringify({
      idempotencyKey: parsed.data.idempotencyKey,
      operation: parsed.data.operation,
      result: parsed.data.result ?? null,
    }),
  );
}

export function decodeWeeklyReportResponse(bytes: Uint8Array): WeeklyReportResponse {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    throw new Error("invalid weekly-report response");
  }
  const parsed = weeklyReportResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid weekly-report response");
  return {
    idempotencyKey: parsed.data.idempotencyKey,
    operation: parsed.data.operation,
    result: parsed.data.result ?? null,
  };
}
