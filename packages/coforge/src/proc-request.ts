import {
  agentApiRoutes,
  decodeAgentProcErrorResponse,
  decodeAgentProcListResponse,
  decodeAgentProcLogsResponse,
  decodeAgentProcStartResponse,
  decodeAgentProcStopResponse,
  type AgentProcErrorResponse,
  type AgentProcListResponse,
  type AgentProcLogsRequest,
  type AgentProcLogsResponse,
  type AgentProcStartRequest,
  type AgentProcStartResponse,
  type AgentProcStopRequest,
  type AgentProcStopResponse,
} from "@lrm/coforge-sdk/agent";
import { CliError } from "./cli-error";
import {
  externalRefusalFor,
  issueProxyRequest,
  operationFailedCode,
  requireProxySetup,
} from "./proxy-request";

function tryDecodeProcError(value: unknown): AgentProcErrorResponse | undefined {
  try {
    return decodeAgentProcErrorResponse(value);
  } catch {
    return undefined;
  }
}

function nextActionForProcError(errorBody: AgentProcErrorResponse | undefined): string | undefined {
  if (!errorBody) return undefined;
  if (errorBody.errorCode === "proc_limit") {
    const names = (errorBody.jobs ?? []).map((job) => `${job.name} (pid ${job.pid})`).join(", ");
    const prefix = names ? `Running jobs: ${names}. ` : "";
    return `${prefix}Stop a job with \`coforge proc stop <name>\` (or \`--all\`) before starting another.`;
  }
  if (errorBody.errorCode === "proc_name_exists")
    return "Stop the existing job (`coforge proc stop <name>`) or choose a different `--name`.";
  if (errorBody.errorCode === "proc_not_found")
    return "Run `coforge proc list` to see available background jobs.";
  return undefined;
}

async function procProxyCall<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
  },
  decode: (value: unknown) => T,
  operation: string,
): Promise<T> {
  requireProxySetup(operation, context, proxyUrl);
  const endpoint = proxyEndpoint(request.path);
  for (const [key, value] of Object.entries(request.query ?? {}))
    endpoint.searchParams.set(key, value);
  const hasBody = request.body !== undefined;
  let response: Response;
  try {
    response = await issueProxyRequest(context, endpoint, {
      method: request.method,
      headers: hasBody ? { "content-type": "application/json" } : {},
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(operation),
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  const rawBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const refusal = externalRefusalFor(context, response.status, rawBody);
    if (refusal) throw refusal;
    const errorBody = tryDecodeProcError(rawBody);
    const genericError =
      !errorBody &&
      rawBody &&
      typeof rawBody === "object" &&
      typeof (rawBody as { error?: unknown }).error === "string"
        ? (rawBody as { error: string; code?: string })
        : undefined;
    throw new CliError({
      code: errorBody
        ? errorBody.errorCode.toUpperCase()
        : typeof genericError?.code === "string"
          ? genericError.code
          : operationFailedCode(operation),
      message: errorBody?.error ?? genericError?.error ?? `HTTP ${response.status}`,
      retryable: false,
      ...(errorBody?.jobs ? { details: { jobs: errorBody.jobs } } : {}),
      suggestedNextAction: nextActionForProcError(errorBody),
    });
  }
  return decode(rawBody);
}

export function procRequests(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) {
  return {
    procList: (): Promise<AgentProcListResponse> =>
      procProxyCall(
        proxyEndpoint,
        context,
        proxyUrl,
        { ...agentApiRoutes.local.proc.list, timeoutMs: 10_000 },
        decodeAgentProcListResponse,
        "proc-list",
      ),
    procStart: (body: AgentProcStartRequest): Promise<AgentProcStartResponse> =>
      procProxyCall(
        proxyEndpoint,
        context,
        proxyUrl,
        { ...agentApiRoutes.local.proc.start, body, timeoutMs: 10_000 },
        decodeAgentProcStartResponse,
        "proc-start",
      ),
    procLogs: (request: AgentProcLogsRequest): Promise<AgentProcLogsResponse> =>
      procProxyCall(
        proxyEndpoint,
        context,
        proxyUrl,
        {
          ...agentApiRoutes.local.proc.logs,
          query: {
            name: request.name,
            ...(request.tail !== undefined ? { tail: String(request.tail) } : {}),
            ...(request.offset !== undefined ? { offset: String(request.offset) } : {}),
          },
          timeoutMs: 10_000,
        },
        decodeAgentProcLogsResponse,
        "proc-logs",
      ),
    procStop: (body: AgentProcStopRequest): Promise<AgentProcStopResponse> =>
      procProxyCall(
        proxyEndpoint,
        context,
        proxyUrl,
        { ...agentApiRoutes.local.proc.stop, body, timeoutMs: 20_000 },
        decodeAgentProcStopResponse,
        "proc-stop",
      ),
  };
}
