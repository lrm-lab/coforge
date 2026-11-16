import { decodeAgentManualErrorResponse } from "@lrm/coforge-sdk/agent";
import { MANUAL_NOT_FOUND_NEXT_ACTION } from "./cli-error";
import { envelopeRequest } from "./proxy-request";

/**
 * The Manual routes use the shared domain envelope, with "browse the index" guidance when a
 * topic cannot be found.
 */
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
  );
}
