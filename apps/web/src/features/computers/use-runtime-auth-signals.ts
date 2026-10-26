import { useServerFn } from "@tanstack/react-start";
import { getRouteApi } from "@tanstack/react-router";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getRuntimeAuthSubscriptionToken } from "#src/features/realtime/realtime.functions";
import type { RuntimeAuthSignal } from "#src/server/computers/runtime-auth.server";
import { runtimeAuthChannel } from "./runtime-auth-realtime";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");
const decoder = new TextDecoder();

function parseSignal(data: unknown): RuntimeAuthSignal | undefined {
  try {
    const value: unknown = data instanceof Uint8Array ? JSON.parse(decoder.decode(data)) : data;
    if (typeof value !== "object" || value === null) return undefined;
    const type = (value as { type?: unknown }).type;
    return type === "runtime-auth.login.v1" || type === "runtime-auth.logout.v1"
      ? (value as RuntimeAuthSignal)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The viewer's own runtime sign-in channel, for one Computer, while a sign-in or sign-out dialog is
 * open. `onSubscribed` runs on every (re)subscribe: the channel keeps no history, so whatever a
 * gap swallowed has to be read back then.
 */
export function useRuntimeAuthSignals(
  computerId: string,
  handlers: { onSignal: (signal: RuntimeAuthSignal) => void; onSubscribed: () => void },
) {
  const userId = workspaceRoute.useLoaderData({ select: ({ user }) => user.id });
  const getToken = useServerFn(getRuntimeAuthSubscriptionToken);
  useRealtimeSubscription({
    channel: runtimeAuthChannel(userId),
    getToken,
    onSubscribed: () => handlers.onSubscribed(),
    onPublication: ({ data }) => {
      const signal = parseSignal(data);
      if (signal?.computerId === computerId) handlers.onSignal(signal);
    },
  });
}
