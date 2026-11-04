import type { AgentRequestForwarderPorts } from "./agent-request-forwarder";

/** The runtime's forwarded-request transport, read per request — a restart replaces it. */
export type ForwardingTransport = AgentRequestForwarderPorts["transport"];

/** The refusal of a forwarded request whose transport is not connected. */
export const NOT_CONNECTED = "daemon connection is not connected";

/** The transport's `name` call bound for forwarding, or the refusal when the transport has
 * none — a restart may have replaced it between requests. */
export function transportCall<
  K extends keyof ForwardingTransport,
  P extends { transport: ForwardingTransport },
>(ports: P, name: K, refusal: string): NonNullable<ForwardingTransport[K]> {
  const transport = ports.transport;
  const call = transport[name];
  if (!call) throw new Error(refusal);
  return (call as (...args: never[]) => unknown).bind(transport) as NonNullable<
    ForwardingTransport[K]
  >;
}
