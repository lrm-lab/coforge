import {
  agentApiRoutes,
  decodeAgentAppErrorResponse,
  decodeAppOwnedListResponse,
  decodeAppRegistrationStatusResponse,
  decodeAppSecretRotationResponse,
  type AppOwnedListResponse,
  type AppRegistrationStatusResponse,
  type AppSecretRotationResponse,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest, proxyEndpointOf } from "./proxy-request";

/** `coforge app status|list --owned|rotate-secret`'s requests, through the daemon's local proxy. */
export type AppRegistrationClient = {
  status(selector: { card: string } | { client: string }): Promise<AppRegistrationStatusResponse>;
  owned(): Promise<AppOwnedListResponse>;
  rotateSecret(clientKey: string): Promise<AppSecretRotationResponse>;
};

export function connectAppRegistrationClient(
  context: string,
  proxyUrl: string,
): AppRegistrationClient {
  const route = agentApiRoutes.local.appRegistrations;
  const call = <T>(
    body: Record<string, string>,
    decode: (value: unknown) => T,
    operation: string,
  ) =>
    envelopeRequest(
      proxyEndpointOf(proxyUrl),
      context,
      proxyUrl,
      { method: route.method, path: route.path, body },
      decode,
      decodeAgentAppErrorResponse,
      operation,
    );
  return {
    status: (selector) =>
      call(
        { operation: "register_status", ...selector },
        decodeAppRegistrationStatusResponse,
        "app-status",
      ),
    owned: () => call({ operation: "owned_list" }, decodeAppOwnedListResponse, "app-list"),
    rotateSecret: (clientKey) =>
      call(
        { operation: "rotate_secret", clientKey },
        decodeAppSecretRotationResponse,
        "app-rotate-secret",
      ),
  };
}
