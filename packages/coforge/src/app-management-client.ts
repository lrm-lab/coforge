import {
  createAgentApiClient,
  type AgentApiExtendedClient,
  type AgentAppManagementRequest,
} from "@lrm/coforge-sdk/agent";
import { createAppProxyAgentApiTransport } from "./sdk-proxy-transport";

type Operation = AgentAppManagementRequest["operation"];
type Body<Op extends Operation> = Omit<
  Extract<AgentAppManagementRequest, { operation: Op }>,
  "operation"
>;

/** `coforge app update|logo|clear-logo|transfer-owner|delete|share-link|...`'s requests, each one
 * operation of the daemon's local registration route. */
export type AppManagementClient = {
  call: AgentApiExtendedClient["apps"]["management"]["execute"];
};

export function connectAppManagementClient(context: string, proxyUrl: string): AppManagementClient {
  const client = createAgentApiClient(
    createAppProxyAgentApiTransport(context, proxyUrl, (_route, input) => {
      const op = (input as { operation?: string } | undefined)?.operation ?? "manage";
      return `app-${op.replaceAll("_", "-")}`;
    }),
  );
  return {
    call: <Op extends Operation>(operation: Op, body: Body<Op>) =>
      client.apps.management.execute(operation, body),
  };
}
