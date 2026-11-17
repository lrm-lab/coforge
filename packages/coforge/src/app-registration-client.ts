import {
  createAgentApiClient,
  type AppOwnedListResponse,
  type AppRegistrationStatusResponse,
  type AppSecretRotationResponse,
} from "@lrm/coforge-sdk/agent";
import { createAppProxyAgentApiTransport } from "./sdk-proxy-transport";

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
  const client = createAgentApiClient(
    createAppProxyAgentApiTransport(context, proxyUrl, (_route, input) => {
      const op = (input as { operation?: string } | undefined)?.operation;
      if (op === "register_status") return "app-status";
      if (op === "owned_list") return "app-list";
      return "app-rotate-secret";
    }),
  );
  return {
    status: (selector) => client.apps.registrations.status(selector),
    owned: () => client.apps.registrations.owned(),
    rotateSecret: (clientKey) => client.apps.registrations.rotateSecret(clientKey),
  };
}
