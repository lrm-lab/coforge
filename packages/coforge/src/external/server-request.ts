import { CliError } from "../cli-error";
import { operationFailedCode } from "../proxy-request";
import { externalRefusalOf } from "./refusal";

type ServerRequest = {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  operation: string;
  timeoutMs?: number;
};

export type ServerConnection = { serverUrl: string; apiKey: string };

export function serverUrlOf(serverUrl: string, path: string): URL {
  const url = new URL(serverUrl);
  url.pathname = path;
  url.search = "";
  return url;
}

export async function serverRequest(
  { serverUrl, apiKey }: ServerConnection,
  request: ServerRequest,
): Promise<unknown> {
  const url = serverUrlOf(serverUrl, request.path);
  for (const [key, value] of Object.entries(request.query ?? {}))
    if (value !== undefined) url.searchParams.set(key, value);
  const hasBody = request.body !== undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(request.operation),
      message: "server request failed (network or timeout)",
      retryable: request.method === "GET",
    });
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (response.ok) return parsed;
  const refusal = externalRefusalOf(response.status, parsed);
  if (refusal) throw refusal;
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as {
    error?: unknown;
    code?: unknown;
    retryable?: unknown;
  };
  throw new CliError({
    code:
      typeof body.code === "string" && body.code
        ? body.code.toUpperCase()
        : response.status >= 500
          ? "SERVER_5XX"
          : operationFailedCode(request.operation),
    message: typeof body.error === "string" && body.error ? body.error : `HTTP ${response.status}`,
    retryable: body.retryable === true || (response.status >= 500 && request.method === "GET"),
  });
}
