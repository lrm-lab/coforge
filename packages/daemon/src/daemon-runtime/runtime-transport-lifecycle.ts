import type {
  DaemonConnectionClient,
  DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection-client";

export type RuntimeTransportLifecyclePorts = {
  get transport(): DaemonConnectionClient;
  set transport(value: DaemonConnectionClient);
  transportFactory: DaemonConnectionClientFactory;
  connection: { workspaceId: string; computerId: string };
};

/**
 * Stops the current transport and installs a fresh one, so a later start never reuses a
 * transport that went through `.stop()` and no replaced transport is left connected. Resolves
 * with the stop failure, if any.
 *
 * The fresh transport is installed before the old one is stopped, on purpose: stopping waits
 * on in-flight status RPCs, and nothing that runs meanwhile may still reach the transport being
 * torn down (a late `stop()` of it, or a start racing this one, must see the new one).
 */
export async function replaceTransport(ports: RuntimeTransportLifecyclePorts): Promise<unknown> {
  const replaced = ports.transport;
  ports.transport = ports.transportFactory.create(ports.connection);
  try {
    await replaced.stop();
    return undefined;
  } catch (error) {
    return error;
  }
}

export function subscribe(
  subscriptions: Array<() => void>,
  unsubscribe: (() => void) | undefined,
): void {
  if (unsubscribe) subscriptions.push(unsubscribe);
}

export function unsubscribeAll(subscriptions: Array<() => void>): void {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
}
