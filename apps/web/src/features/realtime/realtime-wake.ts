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
 * - the browser is back online.
 * Only a connection that still says it is connected is reconnected: one the client already knows
 * is down, it is reconnecting itself, and a second connect would cut that one off (a wake from
 * sleep fired the client's own reconnect and this one together: two sockets, the first dropped
 * 24ms in, and every channel's subscribe failing with it).
 */
export const REALTIME_WAKE = { hiddenMs: 30_000, tickMs: 5_000, sleptMs: 15_000 };

/** How close to its expiry a connection token is dropped at a wake rather than reused. */
const TOKEN_MARGIN_MS = 30_000;

/**
 * Whether the JWT `token` has expired, or will within `marginMs` of `now`, by its own `exp`. A
 * token that cannot be read counts as expiring: dropping it only costs fetching a new one.
 */
export function tokenExpiring(token: string | undefined, now: number, marginMs = TOKEN_MARGIN_MS) {
  if (!token) return false;
  try {
    const payload = token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/");
    const { exp } = JSON.parse(atob(payload)) as { exp?: unknown };
    return typeof exp !== "number" || exp * 1000 - now < marginMs;
  } catch {
    return true;
  }
}

export function createRealtimeWake({
  now,
  connected,
  reconnect,
  dropStaleToken,
  timing = REALTIME_WAKE,
}: {
  now: () => number;
  connected: () => boolean;
  reconnect: () => void;
  /** Called at every wake, before anything reconnects: the client's next connect, its own or
   * this one, must not present a connection token that expired meanwhile. */
  dropStaleToken: () => void;
  timing?: typeof REALTIME_WAKE;
}) {
  let hiddenAt: number | undefined;
  let lastTick: number | undefined;
  const reconnectIfConnected = () => {
    if (connected()) reconnect();
  };
  const woke = (reconnectNow: boolean) => {
    dropStaleToken();
    if (reconnectNow) reconnectIfConnected();
  };
  return {
    hidden() {
      hiddenAt = now();
      lastTick = undefined;
    },
    visible() {
      const away = hiddenAt === undefined ? 0 : now() - hiddenAt;
      hiddenAt = undefined;
      lastTick = now();
      woke(away >= timing.hiddenMs);
    },
    tick() {
      if (hiddenAt !== undefined) return;
      const at = now();
      const slept = lastTick !== undefined && at - lastTick >= timing.sleptMs;
      lastTick = at;
      if (slept) woke(true);
    },
    online: () => woke(true),
  };
}

/**
 * Watches the page for the moments above and reconnects `client`; returns the stop. `token` is
 * the connection token the client last fetched: at a wake one that has expired, or is about to,
 * is dropped (`setToken("")`, the client's public way to make its next connect fetch a new one),
 * so a long sleep or time offline costs no connect rejected with 109 (token expired) and the
 * retry wait that follows it. Call it before `client.connect()`: its `online` listener must run
 * before the client's own, which reconnects at once.
 */
export function watchRealtimeWake(
  client: {
    state: string;
    connect: () => void;
    disconnect: () => void;
    setToken: (token: string) => void;
  },
  token: () => string | undefined,
) {
  const wake = createRealtimeWake({
    now: () => Date.now(),
    connected: () => client.state === "connected",
    dropStaleToken: () => {
      if (tokenExpiring(token(), Date.now())) client.setToken("");
    },
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
