/**
 * Whether the page's realtime connection is worth telling anyone about, from the client's own
 * state changes, the browser's online state and the person's Retry. A blip that the client
 * recovers from in a moment is not: the status stays quiet for `RECONNECTING_AFTER_MS`, says it is
 * reconnecting until `OFFLINE_AFTER_MS`, and then that the page is offline (longer than that reads
 * as stuck). A first connect that is slow is not "reconnecting" (nothing was lost yet), but is
 * offline in the end all the same.
 */

/** The client's own states (Centrifuge's `State`). `disconnected` is for good: the page
 * disconnected it, or the server said not to reconnect. */
export type ClientState = "connected" | "connecting" | "disconnected";

export type ConnectionStatus = "quiet" | "reconnecting" | "offline";

export const RECONNECTING_AFTER_MS = 2_000;
export const OFFLINE_AFTER_MS = 10_000;

export type Connection = {
  state: ClientState;
  /** When the client entered `state`. */
  since: number;
  everConnected: boolean;
  /** The person pressed Retry and the client has not connected or stopped since. */
  retrying: boolean;
  browserOnline: boolean;
  /** When the connection last dropped, while it is down; unknown when it never connected. */
  lostAt: number | null;
};

export type ConnectionEvent =
  | { type: ClientState }
  | { type: "retry" }
  | { type: "browser"; online: boolean };

export function initialConnection(state: ClientState, now: number, browserOnline: boolean) {
  const connected = state === "connected";
  return {
    state,
    since: now,
    everConnected: connected,
    retrying: false,
    browserOnline,
    lostAt: null,
  } satisfies Connection;
}

export function connectionEvent(
  connection: Connection,
  event: ConnectionEvent,
  now: number,
): Connection {
  switch (event.type) {
    case "browser":
      return { ...connection, browserOnline: event.online };
    case "retry":
      return { ...connection, retrying: true };
    case "connected":
      return {
        ...connection,
        state: "connected",
        since: now,
        everConnected: true,
        retrying: false,
        lostAt: null,
      };
    case "connecting":
    case "disconnected": {
      const lostAt = connection.lostAt ?? (connection.everConnected ? now : null);
      const since = connection.state === event.type ? connection.since : now;
      const retrying = event.type === "connecting" && connection.retrying;
      return { ...connection, state: event.type, since, retrying, lostAt };
    }
  }
}

/** What a connection that is connecting says from when on, earliest first. */
function stagesWhileConnecting(connection: Connection) {
  const stages: Array<{ from: number; status: ConnectionStatus }> = [
    { from: connection.since, status: connection.retrying ? "reconnecting" : "quiet" },
  ];
  // A first connect has lost nothing yet; Retry is reconnecting from the start.
  if (connection.everConnected && !connection.retrying)
    stages.push({ from: connection.since + RECONNECTING_AFTER_MS, status: "reconnecting" });
  stages.push({ from: connection.since + OFFLINE_AFTER_MS, status: "offline" });
  return stages;
}

export function connectionStatus(connection: Connection, now: number): ConnectionStatus {
  if (!connection.browserOnline || connection.state === "disconnected") return "offline";
  if (connection.state === "connected") return "quiet";
  const reached = stagesWhileConnecting(connection).filter((stage) => stage.from <= now);
  return reached.at(-1)?.status ?? "quiet";
}

/** When the status changes next with nothing else happening, for a timer to show it then. */
export function nextStatusChangeAt(connection: Connection, now: number): number | undefined {
  if (!connection.browserOnline || connection.state !== "connecting") return undefined;
  return stagesWhileConnecting(connection).find((stage) => stage.from > now)?.from;
}
