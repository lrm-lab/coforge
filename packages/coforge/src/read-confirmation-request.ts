import { agentApiRoutes, type AgentReadRequest } from "@lrm/coforge-sdk/agent";
import { proxyHttpFailure, proxyTransportFailure } from "./local-proxy-failure";
import {
  issueProxyRequest,
  preIssuanceError,
  proxyEndpointOf,
  readProxyErrorBody,
  requireProxySetup,
} from "./proxy-request";
import { unavailableReadConfirmation, type ReadConfirmationTransport } from "./read-confirmation";

export function readConfirmationTransport(
  context: string,
  proxyUrl: string,
  conversationTarget?: string,
): Required<ReadConfirmationTransport> {
  const endpoint = proxyEndpointOf(proxyUrl);
  return {
    async readConfirmation(request: AgentReadRequest): Promise<unknown> {
      const operation = "read-confirmation";
      requireProxySetup(operation, context, proxyUrl);
      if (conversationTarget)
        throw preIssuanceError(operation, "Delivery-confirmed reads need a full Agent session");
      const route = agentApiRoutes.proxy.readConfirmation[request.operation];
      let response: Response;
      try {
        response = await issueProxyRequest(context, endpoint(route.path), {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw proxyTransportFailure(operation, undefined, { idempotent: true });
      }
      if (response.ok)
        return response.json().catch(() => {
          throw unavailableReadConfirmation();
        });
      const failure = await readProxyErrorBody(response);
      if (response.status === 404 && !failure.json?.code) throw unavailableReadConfirmation();
      throw proxyHttpFailure(operation, response.status, failure, undefined, {
        idempotent: true,
        context,
      });
    },
  };
}
