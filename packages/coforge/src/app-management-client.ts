import {
  agentApiRoutes,
  decodeAgentAppErrorResponse,
  decodeAppDeletedResponse,
  decodeAppManagedResponse,
  decodeAppOwnerTransferResponse,
  decodeAppPublishRequestResponse,
  decodeAppSecretRotationResponse,
  decodeAppShareLinkCreatedResponse,
  decodeAppShareLinkRevokedResponse,
  decodeAppShareLinkStatusResponse,
  type AgentAppManagementRequest,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest, proxyEndpointOf } from "./proxy-request";

type Operation = AgentAppManagementRequest["operation"];
type Body<Op extends Operation> = Omit<
  Extract<AgentAppManagementRequest, { operation: Op }>,
  "operation"
>;

const DECODERS = {
  rotate_secret: decodeAppSecretRotationResponse,
  update: decodeAppManagedResponse,
  logo_set: decodeAppManagedResponse,
  logo_clear: decodeAppManagedResponse,
  transfer_owner: decodeAppOwnerTransferResponse,
  delete: decodeAppDeletedResponse,
  share_link_create: decodeAppShareLinkCreatedResponse,
  share_link_status: decodeAppShareLinkStatusResponse,
  share_link_revoke: decodeAppShareLinkRevokedResponse,
  request_publish: decodeAppPublishRequestResponse,
  request_unpublish: decodeAppPublishRequestResponse,
} as const satisfies Record<Operation, (value: unknown) => unknown>;

/** `coforge app update|logo|clear-logo|transfer-owner|delete|share-link|...`'s requests, each one
 * operation of the daemon's local registration route. */
export type AppManagementClient = {
  call<Op extends Operation>(
    operation: Op,
    body: Body<Op>,
  ): Promise<ReturnType<(typeof DECODERS)[Op]>>;
};

export function connectAppManagementClient(context: string, proxyUrl: string): AppManagementClient {
  const route = agentApiRoutes.local.appRegistrations;
  return {
    call: (operation, body) =>
      envelopeRequest(
        proxyEndpointOf(proxyUrl),
        context,
        proxyUrl,
        { method: route.method, path: route.path, body: { operation, ...body } },
        DECODERS[operation] as (value: unknown) => never,
        decodeAgentAppErrorResponse,
        `app-${operation.replaceAll("_", "-")}`,
      ),
  };
}
