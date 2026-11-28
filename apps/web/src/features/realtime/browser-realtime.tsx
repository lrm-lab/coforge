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

export type BrowserRealtimeSubscription = Subscription;

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
  if (client === undefined)
    throw new Error("useBrowserRealtime must be called inside BrowserRealtimeProvider");
  return client;
}

export function useRealtimeConnection() {
  const client = useBrowserRealtime();
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

export type RealtimePublication = { channel: string; data: unknown; position?: StreamPosition };

export type RealtimeClient = Pick<ClientInfo, "client" | "user">;

export type RealtimeSubscriptionError = {
  channel: string;
  code: number;
  message: string;
};

export type SharedRealtimeClient = Pick<Centrifuge, "newSubscription" | "removeSubscription">;

type SharedSubscriptionEntry = {
  subscription: Subscription;
  refCount: number;
  position?: StreamPosition;
  publicationHandlers: Set<(publication: RealtimePublication) => void>;
  subscribedHandlers: Set<(recovery: SubscribedRecovery) => void>;
  subscribingHandlers: Set<() => void>;
  joinHandlers: Set<(client: RealtimeClient) => void>;
  leaveHandlers: Set<(client: RealtimeClient) => void>;
  errorHandlers: Set<(error: RealtimeSubscriptionError) => void>;
};

const sharedSubscriptions = new WeakMap<
  SharedRealtimeClient,
  Map<string, SharedSubscriptionEntry>
>();

function runHandler<T>(channel: string, handler: (value: T) => void, value: T) {
  try {
    handler(value);
  } catch (error) {
    console.error(`realtime handler failed on ${channel}`, error);
  }
}

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
    const subscribingHandlers = new Set<() => void>();
    const joinHandlers = new Set<(client: RealtimeClient) => void>();
    const leaveHandlers = new Set<(client: RealtimeClient) => void>();
    const errorHandlers = new Set<(error: RealtimeSubscriptionError) => void>();
    const created: SharedSubscriptionEntry = {
      subscription,
      refCount: 0,
      publicationHandlers,
      subscribedHandlers,
      subscribingHandlers,
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
    subscription.on("subscribing", () => {
      dispatch(channel, subscribingHandlers, undefined);
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
    subscription.on("join", ({ info }) => {
      dispatch(channel, joinHandlers, info);
    });
    subscription.on("leave", ({ info }) => {
      dispatch(channel, leaveHandlers, info);
    });
    subscription.on("error", (event) => {
      console.warn(`realtime subscription error on ${channel}`, event.error);
      dispatch(channel, errorHandlers, {
        channel,
        code: event.error.code,
        message: event.error.message,
      });
    });
    subscription.on("unsubscribed", (event) => {
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
  onSubscribed?: (recovery: SubscribedRecovery) => void;
  onSubscribing?: () => void;
  onPublication?: (publication: RealtimePublication) => void;
  onJoin?: (client: RealtimeClient) => void;
  onLeave?: (client: RealtimeClient) => void;
  onError?: (error: RealtimeSubscriptionError) => void;
};

export function subscribeToSharedRealtime(
  client: SharedRealtimeClient,
  {
    channel,
    recoverable,
    positioned,
    onSubscribed,
    onSubscribing,
    onPublication,
    onJoin,
    onLeave,
    onError,
  }: SharedRealtimeOptions,
): () => void {
  const entry = acquireSharedSubscription(client, channel, { recoverable, positioned });
  const onPublicationHandler = (publication: RealtimePublication) => onPublication?.(publication);
  const onSubscribedHandler = (recovery: SubscribedRecovery) => onSubscribed?.(recovery);
  const onSubscribingHandler = () => onSubscribing?.();
  const onJoinHandler = (joined: RealtimeClient) => onJoin?.(joined);
  const onLeaveHandler = (left: RealtimeClient) => onLeave?.(left);
  const onErrorHandler = (error: RealtimeSubscriptionError) => onError?.(error);
  entry.publicationHandlers.add(onPublicationHandler);
  entry.subscribedHandlers.add(onSubscribedHandler);
  entry.subscribingHandlers.add(onSubscribingHandler);
  entry.joinHandlers.add(onJoinHandler);
  entry.leaveHandlers.add(onLeaveHandler);
  entry.errorHandlers.add(onErrorHandler);
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
    entry.subscribingHandlers.delete(onSubscribingHandler);
    entry.joinHandlers.delete(onJoinHandler);
    entry.leaveHandlers.delete(onLeaveHandler);
    entry.errorHandlers.delete(onErrorHandler);
    releaseSharedSubscription(client, channel);
  };
}

export type TokenizedRealtimeOptions = {
  channel: string;
  token: string;
  getToken: () => Promise<string>;
  onSubscribed?: () => void;
  onSubscribing?: () => void;
  onPublication?: (publication: RealtimePublication) => void;
  onError?: (error: RealtimeSubscriptionError) => void;
  onUnsubscribed?: (event: { code: number; reason: string }) => void;
};

export function subscribeToTokenizedRealtime(
  client: SharedRealtimeClient,
  {
    channel,
    token,
    getToken,
    onSubscribed,
    onSubscribing,
    onPublication,
    onError,
    onUnsubscribed,
  }: TokenizedRealtimeOptions,
): () => void {
  const subscription = client.newSubscription(channel, {
    token,
    getToken: () => getToken(),
    recoverable: false,
    positioned: false,
  });
  let released = false;
  subscription.on("subscribed", () => {
    if (!released && onSubscribed) runHandler(channel, onSubscribed, undefined);
  });
  subscription.on("subscribing", () => {
    if (!released && onSubscribing) runHandler(channel, onSubscribing, undefined);
  });
  subscription.on("publication", (publication) => {
    if (!released && onPublication) {
      runHandler(channel, onPublication, { channel, data: publication.data });
    }
  });
  subscription.on("error", (event) => {
    if (!released && onError) {
      runHandler(channel, onError, {
        channel,
        code: event.error.code,
        message: event.error.message,
      });
    }
  });
  subscription.on("unsubscribed", (event) => {
    if (released) return;
    if (onUnsubscribed) {
      runHandler(channel, onUnsubscribed, { code: event.code, reason: event.reason });
    }
    if (event.code !== 0 && event.code !== 2 && onError) {
      runHandler(channel, onError, {
        channel,
        code: event.code,
        message: event.reason,
      });
    }
  });
  subscription.subscribe();
  return () => {
    if (released) return;
    released = true;
    subscription.unsubscribe();
    client.removeSubscription(subscription);
  };
}

export function useRealtimeSubscription({
  channel,
  recoverable,
  positioned,
  onSubscribed,
  onSubscribing,
  onPublication,
  onJoin,
  onLeave,
  onError,
}: Omit<SharedRealtimeOptions, "channel"> & { channel?: string }) {
  const client = useBrowserRealtime();
  const handlers = useRef({
    channel,
    onSubscribed,
    onSubscribing,
    onPublication,
    onJoin,
    onLeave,
    onError,
  });

  useEffect(() => {
    handlers.current = {
      channel,
      onSubscribed,
      onSubscribing,
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
      onSubscribing: () => current()?.onSubscribing?.(),
      onJoin: (joined) => current()?.onJoin?.(joined),
      onLeave: (left) => current()?.onLeave?.(left),
      onError: (error) => current()?.onError?.(error),
    });
  }, [client, channel, recoverable, positioned]);
}

export function useRealtimeSubscriptions({
  channels,
  onPublication,
  onSubscribed,
}: {
  channels: readonly string[];
  onPublication: (channel: string, publication: RealtimePublication) => void;
  onSubscribed?: (channel: string, recovery: SubscribedRecovery) => void;
}) {
  const client = useBrowserRealtime();
  const handlers = useRef({ onPublication, onSubscribed });

  useEffect(() => {
    handlers.current = { onPublication, onSubscribed };
  });
  const channelKey = [...new Set(channels)].sort().join("\u0000");

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
