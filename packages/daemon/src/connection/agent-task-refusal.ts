import { AgentExplainedRefusalError } from "./agent-explained-refusal-error";
import { readUpstreamErrorCode } from "./agent-http-wire";
import { AgentUpstreamRefusalError } from "./agent-upstream-refusal-error";

/**
 * The error a non-2xx Task response becomes. A refusal in the Agent API's shape was written for
 * the Agent, so it is relayed with its reason. Any other body is an upstream's internals, not this
 * API's to publish: only its `code` is kept, for the daemon's own log (see
 * `classifyAgentProxyFailure`).
 */
export async function taskRefusalError(response: Response) {
  const text = await response.text();
  return (
    AgentExplainedRefusalError.fromResponse(response.status, text) ??
    new AgentUpstreamRefusalError(
      `server Agent Task request failed (${response.status})`,
      await readUpstreamErrorCode(new Response(text)),
      response.status,
    )
  );
}
