import { getLogger } from "@logtape/logtape";
import { scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "daemon-runtime"]);

/** A numeric HTTP status an error carries, directly or on its cause. */
function httpStatus(error: unknown): number | undefined {
  for (const candidate of [error, (error as { cause?: unknown }).cause]) {
    const value =
      (candidate as { status?: unknown; statusCode?: unknown })?.status ??
      (candidate as { statusCode?: unknown })?.statusCode;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** The `retry-after` an error carries, as seconds or an HTTP date. */
function retryAfter(error: unknown): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown }).cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as {
      retryAfter?: unknown;
      headers?: Record<string, unknown> | Headers;
    };
    const direct = record.retryAfter;
    if (typeof direct === "string" && direct.trim()) return direct.trim().slice(0, 64);
    if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
    const headers = record.headers;
    const header =
      headers instanceof Headers
        ? headers.get("retry-after")
        : ((headers as Record<string, unknown> | undefined)?.["retry-after"] ??
          (headers as Record<string, unknown> | undefined)?.["Retry-After"]);
    if (typeof header === "string" && header.trim()) return header.trim().slice(0, 64);
  }
  return undefined;
}

/**
 * One line per usage read, whatever its outcome: which runtime, the normalized status, how long
 * it took, and — for a failure — the error's own class, HTTP status and `retry-after` when it
 * carries them, and its redacted message. Logging only: nothing here throttles or changes a scan,
 * so a week of these lines can answer how often each runtime is read and how often a provider
 * refuses it.
 *
 * There is no automatic/manual split: the browser decides that, and it never reaches the
 * Computer. The cloud control channel is also the only wired caller (the local RPC port has no
 * implementation today), so a source field would be one constant.
 */
export function logUsageScan(input: {
  provider: RuntimeProvider;
  status: string;
  durationMs: number;
  error?: unknown;
}): void {
  const status = input.error === undefined ? undefined : httpStatus(input.error);
  const retry = input.error === undefined ? undefined : retryAfter(input.error);
  const failure =
    input.error instanceof Error
      ? {
          error_code: input.error.name || "Error",
          message: scrubRuntimeErrorText(input.error.message),
          ...(status === undefined ? {} : { http_status: status }),
          ...(retry === undefined ? {} : { retry_after: retry }),
        }
      : {};
  logger.info("usage scan finished", {
    event: "agent.runtime.usage_scan",
    provider: input.provider,
    status: input.status,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    ...failure,
  });
}
