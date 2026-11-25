import { decodeAgentManualErrorResponse } from "@lrm/coforge-sdk/agent";
import { MANUAL_NOT_FOUND_NEXT_ACTION } from "./cli-error";
import { envelopeRequest } from "./proxy-request";

const manualUnavailable = Symbol("manual unavailable");

export function isManualUnavailable(error: unknown): boolean {
  return error instanceof Error && manualUnavailable in error;
}

export function manualRecoveryText(profileSlug: string | undefined): string {
  const status = profileSlug
    ? `coforge agent status --profile ${profileSlug}`
    : "coforge-computer status";
  return [
    "Manual recovery",
    `Run \`${status}\` to check the connection.`,
    "If status reports a problem or the Manual is still unavailable, wait briefly and retry the manual command once.",
    "If it still fails, report the error code or message and the time to your Workspace administrator.",
  ].join("\n");
}

export async function manualRequest<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  path: string,
  query: Record<string, string>,
  decode: (value: unknown) => T,
): Promise<T> {
  return envelopeRequest(
    proxyEndpoint,
    context,
    proxyUrl,
    { method: "GET", path, query },
    decode,
    decodeAgentManualErrorResponse,
    "manual",
    (code) => (code === "knowledge_not_found" ? MANUAL_NOT_FOUND_NEXT_ACTION : undefined),
    (failure) => Object.assign(failure, { [manualUnavailable]: true }),
  );
}
