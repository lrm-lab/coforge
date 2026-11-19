import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubRuntimeErrorText } from "#src/runtime-error-text";
import type { AcpSessionProfile, AcpTurnReader } from "./profile";

type FailureEvent = Extract<AgentRuntimeEvent, { type: "error" }>;

export function acpPromptFailure(
  error: unknown,
  profile: Pick<AcpSessionProfile, "label" | "detailMessage" | "annotateFailure">,
): FailureEvent {
  const rpcFailure = error instanceof RequestError;
  const data = rpcFailure ? asRecord(error.data) : undefined;
  const detail =
    nonEmptyString(data?.detail) ??
    nonEmptyString(data?.message) ??
    (rpcFailure ? nonEmptyString(error.data) : undefined) ??
    (error instanceof Error ? error.message : `${profile.label} prompt failed`);
  const named = profile.detailMessage?.(detail);
  const event: FailureEvent = named
    ? { type: "error", message: named }
    : {
        type: "error",
        message: scrubRuntimeErrorText(detail),
        ...(rpcFailure ? { providerErrorCode: String(error.code) } : {}),
      };
  return profile.annotateFailure ? profile.annotateFailure(event, error) : event;
}

export function acpSteerResponseFailure(
  response: unknown,
  profile: Pick<AcpSessionProfile, "label" | "stopStatus">,
  updates: AcpTurnReader | undefined,
): FailureEvent | undefined {
  const record = asRecord(response) ?? {};
  const stopReason = nonEmptyString(record.stopReason) ?? "unknown";
  const stop = profile.stopStatus?.(stopReason) ?? {
    status:
      stopReason === "end_turn"
        ? ("completed" as const)
        : stopReason === "cancelled"
          ? ("interrupted" as const)
          : ("failed" as const),
  };
  if (stop.status === "completed") {
    const inBand = updates?.inBandFailure?.(record);
    if (inBand === undefined) return undefined;
    return typeof inBand === "string" ? { type: "error", message: inBand } : inBand;
  }
  if (stop.status === "failed") {
    return {
      type: "error",
      message: stop.error ?? `${profile.label} prompt stopped: ${stopReason}`,
    };
  }
  return undefined;
}
