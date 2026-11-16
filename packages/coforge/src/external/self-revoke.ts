import type { FetchLike } from "./device-client";
import { serverUrlOf } from "./server-request";

export type RevokeOutcome =
  | { state: "revoked" }
  | { state: "already_revoked" }
  | { state: "failed"; detail: string };

/** `POST /credentials/self/revoke` with the key being retired; 401/403/404 mean it is already dead. */
export async function revokeSelf(
  fetchFn: FetchLike,
  serverUrl: string,
  apiKey: string,
): Promise<RevokeOutcome> {
  let response: Response;
  try {
    response = await fetchFn(serverUrlOf(serverUrl, "/api/agent/v1/credentials/self/revoke"), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { state: "failed", detail: "network or timeout" };
  }
  if (response.ok) return { state: "revoked" };
  if (response.status === 401 || response.status === 403 || response.status === 404)
    return { state: "already_revoked" };
  return { state: "failed", detail: `HTTP ${response.status}` };
}
