/**
 * When the page's realtime connection may be dead while it still says it is connected. After the
 * computer sleeps, or the page sits hidden, the socket can be gone without a close ever arriving;
 * the client would only notice when the server's pings stop coming (Centrifugo's 25 seconds plus
 * the client's 10), and on `online` it reconnects only a connection it already knows is down. So
 * it is reconnected at once — and each channel then recovers what it missed, or reads it again
 * (`subscriptionGap`) — when:
 * - the page comes back after `hiddenMs` hidden;
 * - a tick every `tickMs` while the page is visible lands `sleptMs` late: the computer slept.
 *   Ticks are not counted while hidden, where the browser slows timers to one a minute;
 * - the browser is back online and the connection still says it is connected.
 */
export const REALTIME_WAKE = { hiddenMs: 30_000, tickMs: 5_000, sleptMs: 15_000 };

export function createRealtimeWake({
  now,
  connected,
  reconnect,
  timing = REALTIME_WAKE,
}: {
  now: () => number;
  connected: () => boolean;
  reconnect: () => void;
  timing?: typeof REALTIME_WAKE;
}) {
  let hiddenAt: number | undefined;
  let lastTick: number | undefined;
  return {
    hidden() {
      hiddenAt = now();
      lastTick = undefined;
    },
    visible() {
      const away = hiddenAt === undefined ? 0 : now() - hiddenAt;
      hiddenAt = undefined;
      lastTick = now();
      if (away >= timing.hiddenMs) reconnect();
    },
    tick() {
      if (hiddenAt !== undefined) return;
      const at = now();
      const slept = lastTick !== undefined && at - lastTick >= timing.sleptMs;
      lastTick = at;
      if (slept) reconnect();
    },
    online() {
      if (connected()) reconnect();
    },
  };
}

/** Watches the page for the moments above and reconnects `client`; returns the stop. */
export function watchRealtimeWake(client: {
  state: string;
  connect: () => void;
  disconnect: () => void;
}) {
  const wake = createRealtimeWake({
    now: () => Date.now(),
    connected: () => client.state === "connected",
    reconnect: () => {
      client.disconnect();
      client.connect();
    },
  });
  // The tick runs only while the page is visible: a hidden page keeps no timer awake.
  let timer: number | undefined;
  const onVisibility = () => {
    window.clearInterval(timer);
    timer = undefined;
    if (document.visibilityState === "hidden") return wake.hidden();
    wake.visible();
    timer = window.setInterval(() => wake.tick(), REALTIME_WAKE.tickMs);
  };
  const onOnline = () => wake.online();
  if (document.visibilityState === "hidden") wake.hidden();
  else timer = window.setInterval(() => wake.tick(), REALTIME_WAKE.tickMs);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
  };
}
