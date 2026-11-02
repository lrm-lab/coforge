export const NETWORK_FAILURE_HINT =
  "Check your network/VPN; if you need a proxy, set HTTPS_PROXY / HTTP_PROXY / NO_PROXY.";

export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export function isTransientNetworkError(error: unknown, depth = 0): boolean {
  if (!error || depth > 5) return false;
  if (typeof error === "object") {
    const err = error as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof err.code === "string") {
      if (TRANSIENT_CODES.has(err.code) || err.code.startsWith("UND_ERR_")) return true;
    }
    if (typeof err.name === "string") {
      if (err.name === "TimeoutError" || TRANSIENT_CODES.has(err.name)) return true;
    }
    if (typeof err.message === "string") {
      if (
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|TimeoutError|UND_ERR_/i.test(
          err.message,
        )
      ) {
        return true;
      }
    }
    if (err.cause) {
      return isTransientNetworkError(err.cause, depth + 1);
    }
  }
  return false;
}

function collectErrorLabels(error: unknown, depth = 0): string[] {
  if (!error || depth > 5) return [];
  const labels: string[] = [];
  if (typeof error === "object") {
    const err = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof err.code === "string" && err.code) {
      labels.push(err.code);
    } else if (
      typeof err.name === "string" &&
      err.name &&
      err.name !== "Error" &&
      err.name !== "TypeError"
    ) {
      labels.push(err.name);
    }
    if (err.cause) {
      labels.push(...collectErrorLabels(err.cause, depth + 1));
    }
  }
  return labels;
}

export function describeNetworkError(error: unknown): string {
  const labels = collectErrorLabels(error);
  if (labels.length > 0) {
    return Array.from(new Set(labels)).join("/");
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "network error";
}

export function lostConnectionMessage(
  host: string,
  cause: string,
  retryCmd = "coforge-computer login",
): string {
  return `Lost connection to ${host} while waiting for approval (${cause}). ${NETWORK_FAILURE_HINT} Then run \`${retryCmd}\` again.`;
}
