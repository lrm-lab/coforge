import {
  decodeAgentTaskIdleNudgeResponse,
  type AgentTaskIdleNudgeRequest,
  type AgentTaskIdleNudgeResponse,
} from "@lrm/coforge-sdk/agent";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import {
  agentHeaders,
  fetchAgentResponse,
  type AgentHttpInput,
  type HttpFetch,
} from "./agent-http-wire";
import { AgentTransportError } from "./agent-transport-error";

export interface AgentTaskIdleNudgeHttpClient {
  /** `undefined` is the route's 404: this server has no idle nudge yet. */
  execute(
    input: AgentHttpInput<AgentTaskIdleNudgeRequest>,
  ): Promise<AgentTaskIdleNudgeResponse | undefined>;
}

/** `timeoutMs` bounds each request; production's client uses `AGENT_RPC_TIMEOUT_MS`. */
export const createAgentTaskIdleNudgeHttpClient = (
  timeoutMs: number,
  fetcher: HttpFetch = fetch,
): AgentTaskIdleNudgeHttpClient => ({
  async execute({ url, request, ...keys }) {
    const response = await fetchAgentResponse(
      fetcher,
      url,
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      },
      "Agent task idle-nudge",
    );
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse("Agent task idle-nudge", response.status);
    return decodeAgentTaskIdleNudgeResponse(await response.json());
  },
});

/** What the transport supplies to one idle-nudge call. */
export type TaskIdleNudgePorts = {
  assertConnected(): void;
  endpoint(what: string, path: string): string;
  keys(agentApiKey: string): { agentApiKey: string; daemonApiKey: string };
  client: AgentTaskIdleNudgeHttpClient;
};

/** `coforge`'s own idle question; `undefined` when this server has no such route (404). */
export function taskIdleNudge(
  ports: TaskIdleNudgePorts,
  request: AgentTaskIdleNudgeRequest,
  agentApiKey: string,
): Promise<AgentTaskIdleNudgeResponse | undefined> {
  ports.assertConnected();
  return ports.client.execute({
    url: ports.endpoint("Agent task idle-nudge HTTP", agentApiRoutes.cloud.taskIdleNudge.path),
    ...ports.keys(agentApiKey),
    request,
  });
}
