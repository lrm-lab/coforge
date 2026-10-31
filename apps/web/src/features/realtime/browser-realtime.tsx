import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Centrifuge, type ClientInfo, type Subscription } from "centrifuge/build/protobuf";

import {
  connectionEvent,
  connectionStatus,
  initialConnection,
  nextStatusChangeAt,
  type ClientState,
  type Connection,
  type ConnectionEvent,
} from "./connection-status";
import { type StreamPosition, type SubscribedRecovery } from "./subscription-gap";
import { createConnectionJournal } from "./connection-journal";
import { watchRealtimeWake } from "./realtime-wake";

/** The one realtime subscription type for the shared Workspace connection. */
export type BrowserRealtimeSubscription = Subscription;

// `undefined` means no provider above the caller; `null` means the provider's
// connection is not open yet.
const BrowserRealtimeContext = createContext<Centrifuge | null | undefined>(undefined);

export function BrowserRealtimeProvider({
  workspaceId,
  getConnectionToken,
  children,
}: {
  workspaceId?: string;
  getConnectionToken: () => Promise<string>;
  children: ReactNode;
}) {
  const [client, setClient] = useState<Centrifuge | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // The token last fetched, so a wake can tell whether it expired meanwhile.
    let token: string | undefined;
    const journal = createConnectionJournal({ now: Date.now, log: console });
    const next = new Centrifuge(`${protocol}//${location.host}/connection/websocket`, {
      getToken: journal.timeToken(async () => (token = await getConnectionToken())),
    });
    next.on("connecting", journal.connecting);
    next.on("connected", journal.connected);
    next.on("disconnected", journal.disconnected);
    next.on("error", journal.error);
    const stopWake = watchRealtimeWake(next, () => token);
    setClient(next);
    next.connect();
    return () => {
      stopWake();
      setClient(null);
      next.disconnect();
    };
  }, [getConnectionToken, workspaceId]);

  return (
    <BrowserRealtimeContext.Provider value={client}>{children}</BrowserRealtimeContext.Provider>
  );
}

export function useBrowserRealtime() {
  const client = useContext(BrowserRealtimeContext);
  // A subscription hook called in the component that renders the provider sees
  // no client and would silently never subscribe; fail loudly instead.
  if (client === undefined)
    throw new Error("useBrowserRealtime must be called inside BrowserRealtimeProvider");
  return client;
}

/**
 * The shared connection's status as the page shows it (`connection-status.ts`), and the person's
 * Retry: it starts a connect at once, where the client would wait out its backoff. Nothing is
 * re-read here: each channel catches up in its own `onSubscribed`, as for any reconnect.
 */
export function useRealtimeConnection() {
  const client = useBrowserRealtime();
  // Kept with the client it describes: on a Workspace switch the old client's disconnect is not
  // the new one's state, and nothing shows until the new one's is known.
  const [watched, setWatched] = useState<{ client: Centrifuge; connection: Connection } | null>(
    null,
  );
  const connection = watched && watched.client === client ? watched.connection : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!client) return;
    const apply = (event: ConnectionEvent) => {
      const at = Date.now();
      setNow(at);
      setWatched((current) =>
        current?.client === client
          ? { client, connection: connectionEvent(current.connection, event, at) }
          : current,
      );
    };
    setWatched({
      client,
      connection: initialConnection(client.state as ClientState, Date.now(), navigator.onLine),
    });
    const onConnecting = () => apply({ type: "connecting" });
    const onConnected = () => apply({ type: "connected" });
    const onDisconnected = () => apply({ type: "disconnected" });
    const onOnline = () => apply({ type: "browser", online: true });
    const onOffline = () => apply({ type: "browser", online: false });
    client.on("connecting", onConnecting);
    client.on("connected", onConnected);
    client.on("disconnected", onDisconnected);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      client.removeListener("connecting", onConnecting);
      client.removeListener("connected", onConnected);
      client.removeListener("disconnected", onDisconnected);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [client]);

  // Shows the next threshold when it is crossed with nothing else happening.
  const nextChange = connection ? nextStatusChangeAt(connection, now) : undefined;
  useEffect(() => {
    if (nextChange === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextChange - Date.now()));
    return () => clearTimeout(timer);
  }, [nextChange]);

  if (!client || !connection) return null;
  return {
    status: connectionStatus(connection, now),
    lostAt: connection.lostAt,
    browserOnline: connection.browserOnline,
    retry: () => {
      client.disconnect();
      setWatched(
        (current) =>
          current && {
            client: current.client,
            connection: connectionEvent(current.connection, { type: "retry" }, Date.now()),
          },
      );
      client.connect();
    },
  };
}

/** One publication; `position` is where it stands in a positioned channel's stream. */
export type RealtimePublication = { channel: string; data: unknown; position?: StreamPosition };

/** Who joined or left a channel with presence on: the connection's client id and its user. */
export type RealtimeClient = Pick<ClientInfo, "client" | "user">;

/**
 * Subscribes one authorized channel on the shared Workspace connection.
 *
 * The Workspace layout owns the only browser connection; features subscribe
 * through this hook and never construct their own Centrifuge client. No channel
 * carries a token of its own: the subscribe proxy decides who may hold it
 * (`subscribe-proxy.server.ts`).
 */
export type RealtimeSubscriptionError = {
  channel: string;
  code: number;
  message: string;
};

/**
 * One real Centrifuge `Subscription` per channel, shared by every `useRealtimeSubscription` call
 * for that channel on this client — `newSubscription` throws "already exists" on a second call for
 * the same channel, and more than one feature legitimately subscribes to the same `chat:user:`
 * channel (the sidebar's unread badges and in-page notifications). The first
 * caller creates and subscribes it; the last caller's cleanup unsubscribes and removes it. Each
 * caller's own `onPublication`/`onSubscribed`/`onJoin`/`onLeave`/`onError` still only ever sees
 * its own latest closure, exactly as before sharing.
 */
export type SharedRealtimeClient = Pick<Centrifuge, "newSubscription" | "removeSubscription">;

type SharedSubscriptionEntry = {
  subscription: Subscription;
  refCount: number;
  /** Where the stream stands for this subscription (`SubscribedRecovery.position`); undefined on a
   * namespace without history, whose subscribe reports none. The protobuf client hands offsets
   * over as `Long`s despite their `number` type, which compare as strings ("100" < "99"): each
   * is made a number as it comes in (task #358). */
  position?: StreamPosition;
  publicationHandlers: Set<(publication: RealtimePublication) => void>;
  subscribedHandlers: Set<(recovery: SubscribedRecovery) => void>;
  joinHandlers: Set<(client: RealtimeClient) => void>;
  leaveHandlers: Set<(client: RealtimeClient) => void>;
  errorHandlers: Set<(error: RealtimeSubscriptionError) => void>;
};

const sharedSubscriptions = new WeakMap<
  SharedRealtimeClient,
  Map<string, SharedSubscriptionEntry>
>();

/**
 * Runs one of a channel's handlers without letting it throw into the Centrifuge client. The client
 * handles every incoming frame on one promise chain, and a handler that throws leaves that chain
 * unsettled for the client's lifetime: no publication, ping or connect reply is handled again, so
 * the page looks connected while it hears nothing, then cannot reconnect, until it reloads (task
 * #326). A failing handler is logged and skipped.
 */
function runHandler<T>(channel: string, handler: (value: T) => void, value: T) {
  try {
    handler(value);
  } catch (error) {
    console.error(`realtime handler failed on ${channel}`, error);
  }
}

/** `runHandler` for each handler: one that fails leaves the others to run. */
function dispatch<T>(channel: string, handlers: Iterable<(value: T) => void>, value: T) {
  for (const handler of handlers) runHandler(channel, handler, value);
}

function acquireSharedSubscription(
  client: SharedRealtimeClient,
  channel: string,
  options?: { recoverable?: boolean; positioned?: boolean },
): SharedSubscriptionEntry {
  let byChannel = sharedSubscriptions.get(client);
  if (!byChannel) {
    byChannel = new Map();
    sharedSubscriptions.set(client, byChannel);
  }
  let entry = byChannel.get(channel);
  if (!entry) {
    const nativeOptions = {
      ...(options?.recoverable !== undefined ? { recoverable: options.recoverable } : {}),
      ...(options?.positioned !== undefined ? { positioned: options.positioned } : {}),
    };
    const subscription = client.newSubscription(
      channel,
      Object.keys(nativeOptions).length ? nativeOptions : undefined,
    );
    const publicationHandlers = new Set<(publication: RealtimePublication) => void>();
    const subscribedHandlers = new Set<(recovery: SubscribedRecovery) => void>();
    const joinHandlers = new Set<(client: RealtimeClient) => void>();
    const leaveHandlers = new Set<(client: RealtimeClient) => void>();
    const errorHandlers = new Set<(error: RealtimeSubscriptionError) => void>();
    const created: SharedSubscriptionEntry = {
      subscription,
      refCount: 0,
      publicationHandlers,
      subscribedHandlers,
      joinHandlers,
      leaveHandlers,
      errorHandlers,
    };
    subscription.on("subscribed", (context) => {
      created.position = context.streamPosition && {
        epoch: context.streamPosition.epoch,
        offset: Number(context.streamPosition.offset),
      };
      const recovery = {
        wasRecovering: context.wasRecovering,
        recovered: context.recovered,
        position: () => created.position,
      };
      dispatch(channel, subscribedHandlers, recovery);
    });
    subscription.on("publication", (publication) => {
      const stream = created.position;
      const position =
        stream && publication.offset !== undefined
          ? { epoch: stream.epoch, offset: Number(publication.offset) }
          : undefined;
      if (stream && position && position.offset > stream.offset) created.position = position;
      dispatch(channel, publicationHandlers, { ...publication, position });
    });
    // Delivered only on a channel whose namespace pushes join/leave (`force_push_join_leave`).
    subscription.on("join", ({ info }) => {
      dispatch(channel, joinHandlers, info);
    });
    subscription.on("leave", ({ info }) => {
      dispatch(channel, leaveHandlers, info);
    });
    // A failed subscribe otherwise fails silently, leaving the feature looking connected but never
    // updating. A refusal by the subscribe proxy (403) arrives as `unsubscribed` below instead.
    subscription.on("error", (event) => {
      console.warn(`realtime subscription error on ${channel}`, event.error);
      dispatch(channel, errorHandlers, {
        channel,
        code: event.error.code,
        message: event.error.message,
      });
    });
    subscription.on("unsubscribed", (event) => {
      // Codes 0 and 2 are this client's own cleanup (unsubscribe called, client
      // closed); anything else is the server or a token failure dropping us.
      if (event.code === 0 || event.code === 2) return;
      console.warn(`realtime subscription unsubscribed from ${channel}`, event.code, event.reason);
      dispatch(channel, errorHandlers, { channel, code: event.code, message: event.reason });
    });
    byChannel.set(channel, created);
    entry = created;
    subscription.subscribe();
  }
  entry.refCount += 1;
  return entry;
}

function releaseSharedSubscription(client: SharedRealtimeClient, channel: string) {
  const byChannel = sharedSubscriptions.get(client);
  const entry = byChannel?.get(channel);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.subscription.unsubscribe();
  client.removeSubscription(entry.subscription);
  byChannel!.delete(channel);
}

export type SharedRealtimeOptions = {
  channel: string;
  recoverable?: boolean;
  positioned?: boolean;
  /** The channel became `subscribed`: its first subscribe and every resubscribe. The recovery
   * flags say whether publications may have been missed (see `subscriptionGap`). */
  onSubscribed?: (recovery: SubscribedRecovery) => void;
  onPublication?: (publication: RealtimePublication) => void;
  onJoin?: (client: RealtimeClient) => void;
  onLeave?: (client: RealtimeClient) => void;
  onError?: (error: RealtimeSubscriptionError) => void;
};

/** One ref-counted subscription lease, shared by React hooks and imperative message readers. */
export function subscribeToSharedRealtime(
  client: SharedRealtimeClient,
  {
    channel,
    recoverable,
    positioned,
    onSubscribed,
    onPublication,
    onJoin,
    onLeave,
    onError,
  }: SharedRealtimeOptions,
): () => void {
  const entry = acquireSharedSubscription(client, channel, { recoverable, positioned });
  const onPublicationHandler = (publication: RealtimePublication) => onPublication?.(publication);
  const onSubscribedHandler = (recovery: SubscribedRecovery) => onSubscribed?.(recovery);
  const onJoinHandler = (joined: RealtimeClient) => onJoin?.(joined);
  const onLeaveHandler = (left: RealtimeClient) => onLeave?.(left);
  const onErrorHandler = (error: RealtimeSubscriptionError) => onError?.(error);
  entry.publicationHandlers.add(onPublicationHandler);
  entry.subscribedHandlers.add(onSubscribedHandler);
  entry.joinHandlers.add(onJoinHandler);
  entry.leaveHandlers.add(onLeaveHandler);
  entry.errorHandlers.add(onErrorHandler);
  // A caller joining an already-subscribed shared channel missed its "subscribed" event, and
  // everything published before it joined.
  if (entry.subscription.state === "subscribed")
    onSubscribedHandler({
      wasRecovering: false,
      recovered: false,
      position: () => entry.position,
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.publicationHandlers.delete(onPublicationHandler);
    entry.subscribedHandlers.delete(onSubscribedHandler);
    entry.joinHandlers.delete(onJoinHandler);
    entry.leaveHandlers.delete(onLeaveHandler);
    entry.errorHandlers.delete(onErrorHandler);
    releaseSharedSubscription(client, channel);
  };
}

export function useRealtimeSubscription({
  channel,
  recoverable,
  positioned,
  onSubscribed,
  onPublication,
  onJoin,
  onLeave,
  onError,
}: Omit<SharedRealtimeOptions, "channel"> & { channel?: string }) {
  const client = useBrowserRealtime();
  const handlers = useRef({
    channel,
    onSubscribed,
    onPublication,
    onJoin,
    onLeave,
    onError,
  });

  // Install the latest callbacks only after commit, so a superseded channel is
  // unsubscribed before its handlers are replaced and can never dispatch into
  // the new channel's scope.
  useEffect(() => {
    handlers.current = {
      channel,
      onSubscribed,
      onPublication,
      onJoin,
      onLeave,
      onError,
    };
  });

  useEffect(() => {
    if (!client || !channel) return;
    const current = () => (handlers.current.channel === channel ? handlers.current : undefined);
    return subscribeToSharedRealtime(client, {
      channel,
      recoverable,
      positioned,
      onPublication: (publication) => current()?.onPublication?.(publication),
      onSubscribed: (recovery) => current()?.onSubscribed?.(recovery),
      onJoin: (joined) => current()?.onJoin?.(joined),
      onLeave: (left) => current()?.onLeave?.(left),
      onError: (error) => current()?.onError?.(error),
    });
  }, [client, channel, recoverable, positioned]);
}

/**
 * Subscribes a dynamic *set* of authorized channels on the shared Workspace connection — the
 * per-Agent channels added for the viewer's own visible private Agents, one activity and
 * one status channel per Agent, whose membership changes as Agents are created, deleted or
 * change visibility. `useRealtimeSubscription` only ever manages one fixed channel; this hook is
 * its sibling for a channel list, on the same shared subscriptions, diffed by channel name so an
 * Agent leaving the set unsubscribes without disturbing the others.
 */
export function useRealtimeSubscriptions({
  channels,
  onPublication,
  onSubscribed,
}: {
  channels: readonly string[];
  onPublication: (channel: string, publication: RealtimePublication) => void;
  /** `SharedRealtimeOptions.onSubscribed`, for each channel. */
  onSubscribed?: (channel: string, recovery: SubscribedRecovery) => void;
}) {
  const client = useBrowserRealtime();
  const handlers = useRef({ onPublication, onSubscribed });

  useEffect(() => {
    handlers.current = { onPublication, onSubscribed };
  });
  const channelKey = [...new Set(channels)].sort().join("\u0000");

  // Each channel's lease, kept across set changes so a channel staying in the set is not
  // resubscribed (and does not read again what a first subscribe may have missed).
  const leases = useRef(new Map<string, () => void>());
  useEffect(() => {
    if (!client) return;
    const wanted = new Set(channelKey ? channelKey.split("\u0000") : []);
    for (const [channel, release] of leases.current)
      if (!wanted.has(channel)) {
        release();
        leases.current.delete(channel);
      }
    for (const channel of wanted) {
      if (leases.current.has(channel)) continue;
      leases.current.set(
        channel,
        subscribeToSharedRealtime(client, {
          channel,
          onPublication: (publication) => handlers.current.onPublication(channel, publication),
          onSubscribed: (recovery) => handlers.current.onSubscribed?.(channel, recovery),
        }),
      );
    }
  }, [client, channelKey]);
  useEffect(() => {
    const held = leases.current;
    return () => {
      for (const release of held.values()) release();
      held.clear();
    };
  }, [client]);
}
