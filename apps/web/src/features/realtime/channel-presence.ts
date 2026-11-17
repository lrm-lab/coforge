import { useState, useSyncExternalStore } from "react";

import {
  useBrowserRealtime,
  useRealtimeSubscription,
  type RealtimeClient,
} from "#src/features/realtime/browser-realtime";

export class ChannelPresence {
  private clients = new Map<string, string>();
  private online = new Set<string>();
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private read = 0;
  private sinceRead: { joined: boolean; info: RealtimeClient }[] | null = null;

  users = (): ReadonlySet<string> | undefined => (this.loaded ? this.online : undefined);

  isPresent(userId: string): boolean | undefined {
    return this.loaded ? this.online.has(userId) : undefined;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  beginRead() {
    const read = ++this.read;
    this.sinceRead = [];
    return (clients: Record<string, RealtimeClient> | undefined) => {
      if (read !== this.read) return;
      const heard = this.sinceRead ?? [];
      this.sinceRead = null;
      if (!clients) return;
      this.clients = new Map(Object.values(clients).map((info) => [info.client, info.user]));
      for (const { joined, info } of heard) this.apply(joined, info);
      this.loaded = true;
      this.refresh();
    };
  }

  join(info: RealtimeClient) {
    this.sinceRead?.push({ joined: true, info });
    this.apply(true, info);
    this.refresh();
  }

  leave(info: RealtimeClient) {
    this.sinceRead?.push({ joined: false, info });
    this.apply(false, info);
    this.refresh();
  }

  private apply(joined: boolean, info: RealtimeClient) {
    if (joined) this.clients.set(info.client, info.user);
    else this.clients.delete(info.client);
  }

  private refresh() {
    this.online = new Set(this.clients.values());
    if (this.loaded) for (const listener of this.listeners) listener();
  }
}

export function useChannelPresence(channel: string | undefined): ChannelPresence {
  const [store, setStore] = useState(() => ({ channel, presence: new ChannelPresence() }));
  if (store.channel !== channel) setStore({ channel, presence: new ChannelPresence() });
  const { presence } = store;
  const client = useBrowserRealtime();
  useRealtimeSubscription({
    channel,
    onSubscribed: () => {
      if (!client || !channel) return;
      const finish = presence.beginRead();
      client.presence(channel).then(
        (result) => finish(result.clients),
        (error: unknown) => {
          finish(undefined);
          console.warn(`realtime presence read failed on ${channel}`, error);
        },
      );
    },
    onJoin: (info) => presence.join(info),
    onLeave: (info) => presence.leave(info),
  });
  return presence;
}

export function usePresentUsers(presence: ChannelPresence): ReadonlySet<string> | undefined {
  return useSyncExternalStore(presence.subscribe, presence.users, () => undefined);
}
