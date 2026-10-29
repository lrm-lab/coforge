import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { CliError } from "./cli-error";

/** `attachment view`: the file's bytes through the local proxy. */
export async function attachmentViewRequest(
  context: string,
  proxyUrl: string,
  attachmentId: string,
): Promise<{ bytes: Uint8Array; fileName?: string }> {
  if (!context) throw new Error("coforge agent context is not configured");
  if (!/^sfp_[A-Za-z0-9_-]{43}$/.test(context)) throw new Error("coforge agent context is invalid");
  if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
  const endpoint = new URL(proxyUrl);
  endpoint.pathname = agentApiRoutes.local.attachments.path(attachmentId);
  endpoint.search = "";
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${context}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    // VIEW_FAILED (SERVER_5XX for >= 500), with a fixed message for a 404 rather than
    // relaying upstream detail for a missing attachment.
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed && typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Not JSON: keep the raw text (e.g. a legacy bare-text proxy error).
    }
    throw new CliError({
      code: response.status >= 500 ? "SERVER_5XX" : "VIEW_FAILED",
      message: failureMessage(response.status, message),
      retryable: false,
    });
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    fileName: response.headers.get("content-disposition") ?? undefined,
  };
}

/**
 * What a failed download says, from the route's reason (`{ "error": … }`): a missing or forbidden
 * attachment keeps the wording that never reveals which, and a storage failure says what it is
 * instead of reading as a missing file. An older server answers bare text, which is relayed.
 */
function failureMessage(status: number, reason: string): string {
  switch (reason) {
    case "not_found":
      return "Attachment is unavailable.";
    case "object_missing":
      return "The attachment is recorded, but its stored file is missing.";
    case "storage_error":
      return "Storage could not be read; try again in a moment.";
    case "persistence_unavailable":
      return "The server cannot reach its database.";
    default:
      return reason || `HTTP ${status}`;
  }
}
