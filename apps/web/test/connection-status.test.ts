import { describe, expect, test } from "bun:test";

import {
  OFFLINE_AFTER_MS,
  RECONNECTING_AFTER_MS,
  connectionEvent,
  connectionStatus,
  initialConnection,
  nextStatusChangeAt,
  type Connection,
} from "#src/features/realtime/connection-status";

/** The page's connection after a list of events, each at its own time. */
function after(start: Connection, events: Array<[Parameters<typeof connectionEvent>[1], number]>) {
  return events.reduce((connection, [event, at]) => connectionEvent(connection, event, at), start);
}

const live = () => after(initialConnection("connecting", 0, true), [[{ type: "connected" }, 100]]);

describe("connectionStatus", () => {
  test("says nothing while connected", () => {
    expect(connectionStatus(live(), 50_000)).toBe("quiet");
  });

  test("a dropped connection is quiet for a moment, then reconnecting, then offline", () => {
    const dropped = after(live(), [[{ type: "connecting" }, 1_000]]);

    expect(connectionStatus(dropped, 1_000 + RECONNECTING_AFTER_MS - 1)).toBe("quiet");
    expect(connectionStatus(dropped, 1_000 + RECONNECTING_AFTER_MS)).toBe("reconnecting");
    expect(connectionStatus(dropped, 1_000 + OFFLINE_AFTER_MS - 1)).toBe("reconnecting");
    expect(connectionStatus(dropped, 1_000 + OFFLINE_AFTER_MS)).toBe("offline");
  });

  test("a first connect that is slow is not called reconnecting, but is offline in the end", () => {
    const starting = initialConnection("connecting", 0, true);

    expect(connectionStatus(starting, OFFLINE_AFTER_MS - 1)).toBe("quiet");
    expect(connectionStatus(starting, OFFLINE_AFTER_MS)).toBe("offline");
  });

  test("is offline at once when the browser is, and follows the connection when it is back", () => {
    const offline = after(live(), [[{ type: "browser", online: false }, 1_000]]);
    expect(connectionStatus(offline, 1_000)).toBe("offline");

    const back = after(offline, [[{ type: "browser", online: true }, 2_000]]);
    expect(connectionStatus(back, 2_000)).toBe("quiet");
  });

  test("is offline when the client stopped for good", () => {
    const stopped = after(live(), [[{ type: "disconnected" }, 1_000]]);

    expect(connectionStatus(stopped, 1_000)).toBe("offline");
  });

  test("Retry shows reconnecting at once, and offline again only after a fresh wait", () => {
    const retried = after(live(), [
      [{ type: "connecting" }, 1_000],
      [{ type: "disconnected" }, 20_000],
      [{ type: "retry" }, 20_000],
      [{ type: "connecting" }, 20_000],
    ]);

    expect(connectionStatus(retried, 20_000)).toBe("reconnecting");
    expect(connectionStatus(retried, 20_000 + OFFLINE_AFTER_MS)).toBe("offline");
    expect(connectionStatus(after(retried, [[{ type: "connected" }, 21_000]]), 21_000)).toBe(
      "quiet",
    );
  });
});

describe("the connection's lostAt", () => {
  test("is when it first dropped, kept across retries, and cleared once it is back", () => {
    const retried = after(live(), [
      [{ type: "connecting" }, 1_000],
      [{ type: "disconnected" }, 20_000],
      [{ type: "retry" }, 20_000],
      [{ type: "connecting" }, 20_000],
    ]);
    expect(retried.lostAt).toBe(1_000);
    expect(after(retried, [[{ type: "connected" }, 21_000]]).lostAt).toBeNull();
  });

  test("is unknown when the page never connected", () => {
    expect(initialConnection("connecting", 0, true).lostAt).toBeNull();
  });
});

describe("nextStatusChangeAt", () => {
  test("is the next threshold a dropped connection crosses, then none", () => {
    const dropped = after(live(), [[{ type: "connecting" }, 1_000]]);

    expect(nextStatusChangeAt(dropped, 1_000)).toBe(1_000 + RECONNECTING_AFTER_MS);
    expect(nextStatusChangeAt(dropped, 1_000 + RECONNECTING_AFTER_MS)).toBe(
      1_000 + OFFLINE_AFTER_MS,
    );
    expect(nextStatusChangeAt(dropped, 1_000 + OFFLINE_AFTER_MS)).toBeUndefined();
  });

  test("is none while connected or while the browser is offline", () => {
    expect(nextStatusChangeAt(live(), 5_000)).toBeUndefined();
    const offline = after(live(), [
      [{ type: "connecting" }, 1_000],
      [{ type: "browser", online: false }, 1_500],
    ]);
    expect(nextStatusChangeAt(offline, 1_500)).toBeUndefined();
  });
});
