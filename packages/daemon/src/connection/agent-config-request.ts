import { getLogger } from "@logtape/logtape";
import { AGENT_RPC_TIMEOUT_MS } from "./agent-http-wire";

const logger = getLogger(["coforge", "daemon", "agent-launch-config"]);

/** Waits before each retry of a launch-configuration request. Raft retries three times in all,
 * 250 ms apart: a dropped connection right after a Computer wakes is the common case, and the
 * launch is already waiting on it. */
export const AGENT_CONFIG_RETRY_DELAYS_MS: readonly number[] = [250, 250];

/** The upstream statuses that say "try again": the server is busy or the request was throttled,
 * never "this launch is wrong". */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

export type AgentConfigFailure = "network" | "refused" | "server";

/**
 * Why the launch configuration could not be obtained. It carries the last attempt's own evidence
 * so a launch failure can be explained by what happened (no connection, a refusal, a broken
 * server) while the launch reason itself stays `agent_authorization_failed` — no new reason code
 * and no protocol change.
 */
export class AgentConfigRequestError extends Error {
  constructor(
    readonly failure: AgentConfigFailure,
    readonly status: number | undefined,
    readonly upstreamCode: string | undefined,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AgentConfigRequestError";
  }
}

/** Whether another attempt could succeed: a transport failure, a timeout, or a busy server. */
export function retryableAgentConfigFailure(error: unknown): boolean {
  if (!(error instanceof AgentConfigRequestError)) return false;
  if (error.failure === "network") return true;
  return (
    error.status !== undefined && (RETRYABLE_STATUSES.has(error.status) || error.status >= 500)
  );
}

export type AgentConfigRequestOptions = {
  /** The endpoint, or a function so each attempt resolves it afresh after a reconnect. */
  url: string | (() => string);
  /** Names the caller in the error message, e.g. "Agent launch config". */
  what: string;
  method: "POST" | "DELETE";
  token: string;
  body: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
};

/**
 * One launch-configuration request, retried while the failure could be transient. Each attempt
 * logs its status, the server's code and whether it would be retried, so a launch that never got
 * its configuration says which of the three it was.
 */
export async function requestAgentConfig(options: AgentConfigRequestOptions): Promise<Response> {
  const attempt = () => attemptAgentConfig(options);
  const delays = options.retryDelaysMs ?? AGENT_CONFIG_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let index = 0; ; index++) {
    try {
      return await attempt();
    } catch (error) {
      const retryable = retryableAgentConfigFailure(error);
      const failure = error instanceof AgentConfigRequestError ? error : undefined;
      logger.warning("Agent launch configuration request failed", {
        event: "agent_launch_config:request_failed",
        what: options.what,
        attempt: index + 1,
        failure: failure?.failure,
        http_status: failure?.status,
        upstream_code: failure?.upstreamCode,
        retryable,
      });
      if (!retryable || index >= delays.length) throw error;
      await sleep(delays[index]!);
    }
  }
}

async function attemptAgentConfig(options: AgentConfigRequestOptions): Promise<Response> {
  const url = typeof options.url === "function" ? options.url() : options.url;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method,
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: options.body,
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a dropped connection: the server never answered this attempt.
    throw new AgentConfigRequestError(
      "network",
      undefined,
      undefined,
      `${options.what} request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (response.ok) return response;
  const refusal = await refusalCode(response);
  const busy = response.status >= 500 || RETRYABLE_STATUSES.has(response.status);
  throw new AgentConfigRequestError(
    busy ? "server" : "refused",
    response.status,
    refusal?.code,
    refusal?.message
      ? `${options.what} request failed (${response.status}): ${refusal.message}`
      : `${options.what} request failed (${response.status})`,
  );
}

/** The server's own words about a refusal: its `{error, code}` body when it sent one. */
async function refusalCode(
  response: Response,
): Promise<{ code?: string; message?: string } | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    return {
      ...(typeof body.code === "string" ? { code: body.code } : {}),
      ...(typeof body.error === "string" ? { message: body.error } : {}),
    };
  } catch {
    return text.trim() ? { message: text.trim().slice(0, 200) } : undefined;
  }
}
