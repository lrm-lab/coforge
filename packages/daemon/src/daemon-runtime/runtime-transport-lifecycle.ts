import type {
  DaemonConnectionClient,
  DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection-client";

export type RuntimeTransportLifecyclePorts = {
  get transport(): DaemonConnectionClient;
  set transport(value: DaemonConnectionClient);
  transportFactory: DaemonConnectionClientFactory;
  connection: { workspaceId: string; computerId: string };
  subscriptions: Array<() => void>;
};

/** Stops the current transport and installs a fresh one, so a later start never reuses a
 * transport that went through `.stop()` and no replaced transport is left connected. The fresh
 * transport is installed before the old one is stopped so racing status RPCs cannot reach it. */
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
