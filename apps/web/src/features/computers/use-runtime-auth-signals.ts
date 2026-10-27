import { useServerFn } from "@tanstack/react-start";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { getRuntimeAuthSubscriptionToken } from "#src/features/realtime/realtime.functions";
import type { RuntimeAuthSignal } from "#src/server/computers/runtime-auth.server";
import { parseRuntimeAuthSignal, runtimeAuthChannel } from "./runtime-auth-realtime";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

/**
 * The viewer's own runtime sign-in channel, for one Computer, while its runtimes or a sign-in or
 * sign-out dialog are shown. `onSubscribed` runs on every (re)subscribe: the channel keeps no history, so whatever a
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
      const signal = parseRuntimeAuthSignal(data);
      if (signal?.computerId === computerId) handlers.onSignal(signal);
    },
  });
}

/**
 * Re-reads the Computers pages whenever this Computer stores a newer login status, which it reports
 * after every sign-in or sign-out, and after a resubscribe, whose gap may have swallowed one. The
 * dialogs leave this to it: their result arrives before that report.
 */
export function useRuntimeAuthStatusRefresh(computerId: string) {
  const router = useRouter();
  const subscribedBefore = useRef(false);
  const reread = () =>
    void router.invalidate({
      filter: (match) => match.routeId.startsWith("/w/$workspaceSlug/_computers"),
    });
  useRuntimeAuthSignals(computerId, {
    onSubscribed: () => {
      if (subscribedBefore.current) reread();
      subscribedBefore.current = true;
    },
    onSignal: (signal) => {
      if (signal.type === "runtime-auth.status.v1") reread();
    },
  });
}
