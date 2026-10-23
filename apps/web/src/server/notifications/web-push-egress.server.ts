import type { RequestDetails } from "web-push";

import {
  NonPublicAddressError,
  OutboundEgress,
  type FetchOutboundRequest,
  type OutboundTarget,
  type ResolveAddresses,
} from "#src/server/egress/outbound-egress.server";

export type PinnedWebPushTarget = OutboundTarget;

/**
 * Resolves a Web Push endpoint's hostname and validates that every returned address is public
 * (the shared egress rules, `server/egress/`). Returns the hostname alongside one validated
 * address to pin the subsequent request to, preventing a DNS rebind between validation and the
 * request itself.
 */
export async function resolvePinnedWebPushTarget(
  endpoint: string,
  resolve?: ResolveAddresses,
): Promise<PinnedWebPushTarget> {
  try {
    return await new OutboundEgress({ resolve }).resolveTarget(endpoint);
  } catch (error) {
    if (error instanceof NonPublicAddressError) {
      throw new Error("Web Push endpoint must resolve only to public addresses");
    }
    throw error;
  }
}

export type PinnedWebPushResponse = { statusCode: number };

export type FetchWebPushRequest = FetchOutboundRequest;

/** Sends a Web Push request pinned to the validated target address (see `OutboundEgress.send`):
 * no redirect is followed, and a redirect response is a non-2xx failure. */
export async function sendPinnedWebPushRequest(
  requestDetails: RequestDetails,
  target: PinnedWebPushTarget,
  timeoutMs: number,
  fetchImpl: FetchWebPushRequest = fetch,
): Promise<PinnedWebPushResponse> {
  if (new URL(requestDetails.endpoint).hostname !== target.hostname) {
    throw new Error("Web Push hostname changed after validation");
  }
  const { status } = await new OutboundEgress({ fetch: fetchImpl }).send(
    requestDetails.endpoint,
    {
      method: requestDetails.method,
      headers: requestDetails.headers as Record<string, string>,
      body: requestDetails.body ? new Uint8Array(requestDetails.body) : undefined,
    },
    target,
    timeoutMs,
  );
  return { statusCode: status };
}
