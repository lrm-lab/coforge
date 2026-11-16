import { expect, test } from "bun:test";
import {
  connectionLiveness,
  INBOUND_QUIET_MS,
  INBOUND_STALLED_MS,
  LostClientRebuild,
} from "#src/connection/connection-liveness";
import type { DaemonConnectionConfig } from "#src/connection/daemon-connection-client";
import { COMPUTER_STATUS_REFRESH_MS } from "#src/connection/daemon-connection";
import { captureDaemonLogs } from "./log-capture";

test("a connection that carried traffic recently is left alone", () => {
  expect(connectionLiveness(0)).toBe("carrying");
  expect(connectionLiveness(INBOUND_QUIET_MS - 1)).toBe("carrying");
});

test("a quiet connection is reported before it is torn down", () => {
  expect(connectionLiveness(INBOUND_QUIET_MS)).toBe("quiet");
  expect(connectionLiveness(INBOUND_STALLED_MS - 1)).toBe("quiet");
});

test("a connection that has carried nothing for the stalled window must be rebuilt", () => {
  expect(connectionLiveness(INBOUND_STALLED_MS)).toBe("stalled");
  expect(connectionLiveness(INBOUND_STALLED_MS * 10)).toBe("stalled");
});

test("both windows are measured in the status round trips that feed them", () => {
  // The only inbound traffic a Workspace with nothing to say produces is the answered status
  // RPC, so these windows mean nothing except as a count of those refreshes. A window shorter
  // than a couple of them would rebuild a healthy connection over one lost reply.
  expect(INBOUND_QUIET_MS).toBeGreaterThanOrEqual(COMPUTER_STATUS_REFRESH_MS * 2);
  expect(INBOUND_STALLED_MS).toBeGreaterThanOrEqual(COMPUTER_STATUS_REFRESH_MS * 4);
  expect(INBOUND_STALLED_MS).toBeGreaterThan(INBOUND_QUIET_MS);
});

/** The window the failing-rebuild log is held to, spelled as a wall-clock hour. */
const ONE_HOUR_MS = 60 * 60_000;

const REBUILD_CONFIG = {
  workspaceId: "workspace-1",
  computerId: "computer-1",
} as unknown as DaemonConnectionConfig;

/** Lets the rebuild's own start chain settle, so the next attempt is not held by the one in
 * flight. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("a rebuild that keeps failing logs one warning, then at most one an hour", async () => {
  let nowMs = 1_000_000;
  let refusing = true;
  const rebuild = new LostClientRebuild(
    () => ({ token: "daemon-token", config: REBUILD_CONFIG }),
    async () => {
      if (refusing) throw new Error("token expired");
    },
    () => false,
    () => "unauthorized",
    () => nowMs,
  );
  const attempt = async () => {
    rebuild.attempt();
    await settled();
  };

  const { records } = await captureDaemonLogs(async () => {
    // Ten status refreshes' worth of a server that keeps refusing: 2880 of these a day is the
    // noise this exists to stop.
    for (let tick = 0; tick < 10; tick += 1) await attempt();
    nowMs += ONE_HOUR_MS - 60_000;
    await attempt();
    nowMs += 2 * 60_000;
    await attempt();
    refusing = false;
    await attempt();
    await attempt();
  });

  expect(records.map((record) => record.properties.event)).toEqual([
    "daemon_connection:rebuild_failed",
    "daemon_connection:rebuild_failed",
    "daemon_connection:rebuild_recovered",
  ]);
  const [first, hourly, recovered] = records;
  expect(first?.level).toBe("warning");
  expect(first?.properties).toMatchObject({ outcome: "failed", consecutive_failures: 1 });
  expect(first?.properties.failing_for_ms).toBe(0);
  expect(hourly?.level).toBe("warning");
  expect(hourly?.properties).toMatchObject({
    consecutive_failures: 12,
    failing_for_ms: ONE_HOUR_MS + 60_000,
  });
  expect(recovered?.level).toBe("info");
  expect(recovered?.properties).toMatchObject({
    outcome: "recovered",
    consecutive_failures: 12,
    failing_for_ms: ONE_HOUR_MS + 60_000,
  });
});

test("an attempt on its own is a debug record, never a warning", async () => {
  const rebuild = new LostClientRebuild(
    () => ({ token: "daemon-token", config: REBUILD_CONFIG }),
    async () => {
      throw new Error("token expired");
    },
    () => false,
    () => "unauthorized",
    () => 1_000_000,
  );

  const { records } = await captureDaemonLogs(async () => {
    rebuild.attempt();
    await settled();
  }, "debug");

  expect(
    records.filter((record) => record.properties.event === "daemon_connection:rebuild"),
  ).toHaveLength(1);
  expect(records.filter((record) => record.level === "warning")).toHaveLength(1);
});

test("a rebuild that succeeds first time logs no summary to notice", async () => {
  const rebuild = new LostClientRebuild(
    () => ({ token: "daemon-token", config: REBUILD_CONFIG }),
    async () => {},
    () => false,
    () => "unauthorized",
    () => 1_000_000,
  );

  const { records } = await captureDaemonLogs(async () => {
    rebuild.attempt();
    await settled();
  }, "debug");

  expect(records.filter((record) => record.level !== "debug")).toHaveLength(0);
});
