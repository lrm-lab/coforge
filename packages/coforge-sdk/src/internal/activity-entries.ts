import { z } from "zod";
import { codePointLength } from "./truncate";

/** The longest subagent type a lineage carries, in code points. */
export const ACTIVITY_SUBAGENT_TYPE_MAX = 40;
/** A subagent-scoped entry's lineage: the tool call that started the subagent, and the
 * provider's subagent type when it is known (single-line, at most
 * `ACTIVITY_SUBAGENT_TYPE_MAX` code points). */
export type ActivitySubagent = { parentToolUseId: string; subagentType?: string };
export type ActivityTrajectoryEntry = (
  | { kind: "text" | "thinking"; text: string }
  | {
      kind: "tool_start";
      toolName: string;
      toolInput?: string;
      /** The provider's tool call id; the call's `ActivityToolOutcome` names it. */
      callId?: string;
    }
  | { kind: "system"; title: string; text: string }
) & { subagent?: ActivitySubagent };

const singleLineSchema = (maxCodePoints: number) =>
  z.string().refine((value) => validLine(value, maxCodePoints));

const activityTextSchema = z.string().refine((value) => codePointLength(value) <= 2000);
const toolInputSchema = z.string().refine((value) => validToolInput(value));

const activitySubagentSchema = z.object({
  parentToolUseId: singleLineSchema(128),
  subagentType: singleLineSchema(ACTIVITY_SUBAGENT_TYPE_MAX).optional(),
});

const activityEntryRecordSchema = z.looseObject({
  subagent: z.unknown().optional(),
});

const activityEntryPayloadSchema = z.union([
  z.object({
    kind: z.literal("tool_start"),
    toolName: singleLineSchema(128),
    toolInput: toolInputSchema.optional(),
    callId: singleLineSchema(128).optional(),
    text: z.undefined().optional(),
    title: z.undefined().optional(),
  }),
  z.object({
    kind: z.enum(["text", "thinking"]),
    text: activityTextSchema,
    toolName: z.undefined().optional(),
    toolInput: z.undefined().optional(),
    callId: z.undefined().optional(),
    title: z.undefined().optional(),
  }),
  z.object({
    kind: z.literal("system"),
    title: singleLineSchema(120),
    text: activityTextSchema,
    toolName: z.undefined().optional(),
    toolInput: z.undefined().optional(),
    callId: z.undefined().optional(),
  }),
]);

export function parseActivityEntries(value: unknown): ActivityTrajectoryEntry[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("invalid activity entries");
  return value.map((entry: unknown): ActivityTrajectoryEntry => {
    const raw = activityEntryRecordSchema.safeParse(entry);
    if (!raw.success) throw new Error("invalid activity entry");
    let subagent: ActivitySubagent | undefined;
    if (raw.data.subagent !== undefined) {
      const lineage = activitySubagentSchema.safeParse(raw.data.subagent);
      if (!lineage.success) throw new Error("invalid activity lineage");
      subagent = {
        parentToolUseId: lineage.data.parentToolUseId,
        ...(lineage.data.subagentType !== undefined
          ? { subagentType: lineage.data.subagentType }
          : {}),
      };
    }
    const payload = activityEntryPayloadSchema.safeParse(entry);
    if (!payload.success) throw new Error("invalid activity entry payload");
    const scope = subagent ? { subagent } : {};
    if (payload.data.kind === "tool_start") {
      return {
        kind: "tool_start",
        toolName: payload.data.toolName,
        ...(payload.data.toolInput !== undefined ? { toolInput: payload.data.toolInput } : {}),
        ...(payload.data.callId !== undefined ? { callId: payload.data.callId } : {}),
        ...scope,
      };
    }
    if (payload.data.kind === "system") {
      return {
        kind: "system",
        title: payload.data.title,
        text: payload.data.text,
        ...scope,
      };
    }
    return { kind: payload.data.kind, text: payload.data.text, ...scope };
  });
}

/** Whether `value` can be carried as a tool call id (`callId`) on the wire. */
export function isActivityCallId(value: unknown): value is string {
  return validLine(value, 128);
}

function hasAsciiControl(value: string): boolean {
  for (const unit of value) {
    const code = unit.codePointAt(0);
    if (code === undefined || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A non-empty single-line string of at most `maxCodePoints` code points. */
function validLine(value: unknown, maxCodePoints: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= maxCodePoints &&
    !hasAsciiControl(value)
  );
}

// `toolInput`: the short, already-redacted argument summary. Same
// control-character rejection as `validLine`, but it may be empty.
function validToolInput(value: unknown): value is string {
  return typeof value === "string" && codePointLength(value) <= 200 && !hasAsciiControl(value);
}
