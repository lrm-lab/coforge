import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import {
  forwardOpenVikingControl,
  forwardOpenVikingRead,
  type OpenVikingAgentProxyCommand,
} from "#src/openviking-read-proxy";
import { sendAgentJson } from "./agent-http-wire";
import { serverEndpoint } from "./daemon-endpoints";

/** Transport only: the Web use case owns authorization, memory scope and mutations. */
export function agentMemoryHttp(server: string, daemonApiKey: string, agentApiKey: string) {
  const post = (path: string, what: string, body: unknown) =>
    sendAgentJson(fetch, {
      url: serverEndpoint(server, what, path),
      agentApiKey,
      daemonApiKey,
      method: "POST",
      body,
      what,
      timeoutMs: 30_000,
    });
  return {
    memory: (request: unknown) => post(agentApiRoutes.cloud.memory.path, "Agent memory", request),
    disposition: (request: unknown) =>
      post(agentApiRoutes.cloud.memoryDisposition.path, "Memory disposition", request),
    openviking: (request: OpenVikingAgentProxyCommand) => {
      const input = {
        url: serverEndpoint(server, "Agent OpenViking HTTP", agentApiRoutes.cloud.openviking.path),
        command: request,
        agentApiKey,
        daemonApiKey,
      };
      return request.op === "offer" || request.op === "diagnose"
        ? forwardOpenVikingControl({ ...input, command: request })
        : forwardOpenVikingRead({ ...input, command: request });
    },
  };
}
