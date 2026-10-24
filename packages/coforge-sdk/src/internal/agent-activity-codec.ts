import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { parseActivityEntries, type ActivityTrajectoryEntry } from "./activity-entries";
import { isActivityToolOutcome } from "./activity-tool-outcome";
import { safeUint64 } from "./agent-observation-codec";
import { decodeRuntimeError, encodeRuntimeError } from "./runtime-error-action";
import {
  ActivitySystemEntrySchema,
  AgentActivitySchema,
  type AgentActivity as AgentActivityMessage,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { AGENT_ACTIVITY_DETAIL_KIND, type AgentActivity } from "./index";

export function encodeAgentActivity(value: AgentActivity): Uint8Array {
  validateAgentActivity(value);
  return toBinary(
    AgentActivitySchema,
    create(AgentActivitySchema, {
      ...value,
      clientSeq: BigInt(value.clientSeq),
      observedAtMs: BigInt(value.observedAtMs),
      isHeartbeat: value.isHeartbeat ?? false,
      probeId: value.probeId ?? "",
      producerFactId: value.producerFactId ?? "",
      ...encodeRuntimeError(value.runtimeError),
      entries: value.entries?.map((entry) => ({
        content:
          entry.kind === "tool_start"
            ? { case: "toolName" as const, value: entry.toolName }
            : entry.kind === "system"
              ? {
                  case: "system" as const,
                  value: create(ActivitySystemEntrySchema, {
                    title: entry.title,
                    text: entry.text,
                  }),
                }
              : entry.kind === "thinking"
                ? { case: "thinking" as const, value: entry.text }
                : { case: "text" as const, value: entry.text },
        parentToolUseId: entry.subagent?.parentToolUseId ?? "",
        subagentType: entry.subagent?.subagentType ?? "",
        toolInput: entry.kind === "tool_start" ? (entry.toolInput ?? "") : "",
        callId: entry.kind === "tool_start" ? (entry.callId ?? "") : "",
      })),
      toolOutcome: value.toolOutcome && {
        callId: value.toolOutcome.callId,
        ok: value.toolOutcome.ok,
        durationMs:
          value.toolOutcome.durationMs === undefined
            ? undefined
            : BigInt(value.toolOutcome.durationMs),
        exitCode: value.toolOutcome.exitCode,
      },
    }),
  );
}

export function decodeAgentActivity(bytes: Uint8Array): AgentActivity {
  return agentActivityFromMessage(fromBinary(AgentActivitySchema, bytes));
}

/** The Activity an already parsed frame carries; throws for one that breaks the contract. */
export function agentActivityFromMessage(v: AgentActivityMessage): AgentActivity {
  const entries = v.entries.map((entry): ActivityTrajectoryEntry => {
    const scope = entry.parentToolUseId
      ? {
          subagent: {
            parentToolUseId: entry.parentToolUseId,
            ...(entry.subagentType ? { subagentType: entry.subagentType } : {}),
          },
        }
      : {};
    if (entry.content.case === "toolName")
      return {
        kind: "tool_start",
        toolName: entry.content.value,
        ...(entry.toolInput ? { toolInput: entry.toolInput } : {}),
        ...(entry.callId ? { callId: entry.callId } : {}),
        ...scope,
      };
    if (entry.content.case === "system")
      return {
        kind: "system",
        title: entry.content.value.title,
        text: entry.content.value.text,
        ...scope,
      };
    if (entry.content.case === "thinking" || entry.content.case === "text")
      return { kind: entry.content.case, text: entry.content.value, ...scope };
    throw new Error("missing activity entry content");
  });
  const value = {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    agentId: v.agentId,
    detailKind: v.detailKind,
    clientSeq: Number(v.clientSeq),
    level: v.level as AgentActivity["level"],
    detail: v.detail,
    observedAtMs: Number(v.observedAtMs),
    launchId: v.launchId,
    ...(v.activityKind ? { activityKind: v.activityKind as AgentActivity["activityKind"] } : {}),
    ...(v.isHeartbeat ? { isHeartbeat: true } : {}),
    ...(v.probeId ? { probeId: v.probeId } : {}),
    ...(v.producerFactId ? { producerFactId: v.producerFactId } : {}),
    ...(entries.length ? { entries } : {}),
    ...(v.toolOutcome
      ? {
          toolOutcome: {
            callId: v.toolOutcome.callId,
            ok: v.toolOutcome.ok,
            ...(v.toolOutcome.durationMs !== undefined
              ? { durationMs: safeUint64(v.toolOutcome.durationMs, "tool outcome duration") }
              : {}),
            ...(v.toolOutcome.exitCode !== undefined ? { exitCode: v.toolOutcome.exitCode } : {}),
          },
        }
      : {}),
    ...(v.messageId ? { messageId: v.messageId } : {}),
    ...(v.conversationId ? { conversationId: v.conversationId } : {}),
    ...(v.conversationTarget ? { conversationTarget: v.conversationTarget } : {}),
    ...(decodeRuntimeError(v) ? { runtimeError: decodeRuntimeError(v) } : {}),
  };
  validateAgentActivity(value);
  return value;
}

function validateAgentActivity(value: AgentActivity): void {
  if (value.entries !== undefined) parseActivityEntries(value.entries);
  if (
    value.protocolMajor !== 1 ||
    !value.requestId ||
    !value.workspaceId ||
    !value.agentId ||
    !value.launchId ||
    !Number.isSafeInteger(value.clientSeq) ||
    value.clientSeq < 1 ||
    !value.detailKind ||
    !["info", "warning", "error"].includes(value.level) ||
    (value.activityKind !== undefined &&
      !["online", "working", "thinking", "error", "offline"].includes(value.activityKind)) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 1 ||
    (value.toolOutcome !== undefined &&
      (value.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.TOOL_END ||
        !isActivityToolOutcome(value.toolOutcome)))
  )
    throw new Error("invalid agent activity");
}
