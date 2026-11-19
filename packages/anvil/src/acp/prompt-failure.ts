import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubRuntimeErrorText } from "#src/runtime-error-text";
import type { AcpSessionProfile } from "./profile";

export function acpPromptFailure(
  error: unknown,
  profile: Pick<AcpSessionProfile, "label" | "detailMessage">,
): Extract<AgentRuntimeEvent, { type: "error" }> {
  const rpcFailure = error instanceof RequestError;
  const data = rpcFailure ? asRecord(error.data) : undefined;
  const detail =
    nonEmptyString(data?.detail) ??
    nonEmptyString(data?.message) ??
    (rpcFailure ? nonEmptyString(error.data) : undefined) ??
    (error instanceof Error ? error.message : `${profile.label} prompt failed`);
  const named = profile.detailMessage?.(detail);
  return named
    ? { type: "error", message: named }
    : {
        type: "error",
        message: scrubRuntimeErrorText(detail),
        ...(rpcFailure ? { providerErrorCode: String(error.code) } : {}),
      };
}
