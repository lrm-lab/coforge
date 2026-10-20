import { describe, expect, test } from "bun:test";
import { UPGRADE_ERROR_CODE, type ComputerUpgradeResult } from "@lrm/coforge-sdk/internal";
import {
  UPGRADE_RESULT_POLL_MS,
  UPGRADE_RESULT_RETRY_BASE_MS,
  UPGRADE_RESULT_RETRY_MAX_MS,
  UpgradeResultReporter,
  type RecoveredUpgradeResult,
  type UpgradeOperationsReading,
} from "#src/daemon-runtime/upgrade-result-reporter";

const workspaceId = "workspace-a";
const computerId = "computer-a";

/** Timers the test fires by hand: `advance` runs every callback due by then and awaits the pass
 * it starts, so no test waits on real time. */
function manualClock() {
  let now = 0;
  const timers: { at: number; callback: () => Promise<void>; cancelled: boolean }[] = [];
  return {
    schedule(callback: () => Promise<void>, milliseconds: number) {
      const timer = { at: now + milliseconds, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Delays (from now) of the timers still armed. */
    pending: () => timers.filter((timer) => !timer.cancelled).map((timer) => timer.at - now),
    async advance(milliseconds: number) {
      now += milliseconds;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= now)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        due.cancelled = true;
        await due.callback();
      }
    },
  };
}

function failedResult(requestId: string): RecoveredUpgradeResult {
  return {
    requestId,
    status: "failed",
    completedAtMs: 2_000,
    error: "download failed",
    errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
  };
}

/** A transport with `DaemonConnection.sendUpgradeResult`'s dedupe: a request it already put on
 * the wire is a replay and returns false. */
function fakeTransport() {
  const wire: ComputerUpgradeResult[] = [];
  const reported = new Set<string>();
  const state = { connected: true, failNext: 0 };
  return {
    wire,
    state,
    transport: {
      async sendUpgradeResult(result: ComputerUpgradeResult) {
        if (!state.connected) throw new Error("daemon connection is not connected");
        if (state.failNext > 0) {
          state.failNext -= 1;
          throw new Error("rpc failed");
        }
        if (reported.has(result.requestId)) return false;
        wire.push(result);
        reported.add(result.requestId);
        return true;
      },
    },
  };
}

/** The child config as the Coordinator writes it: `pending` while an operation awaits its
 * receipt, terminal results until they are acknowledged. */
function harness(
  options: {
    results?: RecoveredUpgradeResult[];
    pending?: boolean;
    acknowledge?: (requestId: string) => Promise<void>;
    readOperations?: () => Promise<UpgradeOperationsReading>;
  } = {},
) {
  const clock = manualClock();
  const transport = fakeTransport();
  const config = { results: options.results ?? [], pending: options.pending ?? false };
  const acknowledged: string[] = [];
  const reporter = new UpgradeResultReporter({
    workspaceId,
    computerId,
    readOperations:
      options.readOperations ??
      (async () => ({
        // The Coordinator drops an acknowledged operation from the child config.
        results: config.results.filter((result) => !acknowledged.includes(result.requestId)),
        pending: config.pending,
      })),
    transport: () => transport.transport,
    acknowledge:
      options.acknowledge ??
      (async (requestId) => {
        acknowledged.push(requestId);
      }),
    schedule: clock.schedule,
  });
  reporter.start();
  return { clock, transport, config, acknowledged, reporter };
}

describe("UpgradeResultReporter", () => {
  test("a download failure settled while this Workspace stays online is sent with its code and acknowledged within one poll tick", async () => {
    const { clock, transport, config, acknowledged, reporter } = harness({ pending: true });
    // The Coordinator accepted the request and wrote it into this child's config as pending.
    await reporter.report();
    expect(clock.pending()).toEqual([UPGRADE_RESULT_POLL_MS]);

    await clock.advance(UPGRADE_RESULT_POLL_MS);
    expect(transport.wire).toEqual([]);
    expect(clock.pending()).toEqual([UPGRADE_RESULT_POLL_MS]);

    // The Coordinator recorded the failed receipt and rewrote this child's config.
    config.pending = false;
    config.results.push(failedResult("request-a"));
    await clock.advance(UPGRADE_RESULT_POLL_MS);
    expect(transport.wire).toEqual([
      {
        protocolMajor: expect.any(Number),
        requestId: "request-a",
        workspaceId,
        computerId,
        status: "failed",
        completedAtMs: 2_000,
        error: "download failed",
        errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
      },
    ]);
    expect(acknowledged).toEqual(["request-a"]);
    // Nothing is pending any more: polling stops.
    expect(clock.pending()).toEqual([]);
  });

  test("polling continues while the config lists a pending operation and stops once none is", async () => {
    let reads = 0;
    const config = { pending: true };
    const { clock, reporter } = harness({
      readOperations: async () => {
        reads += 1;
        return { results: [], pending: config.pending };
      },
    });
    await reporter.report();
    for (let tick = 0; tick < 3; tick++) await clock.advance(UPGRADE_RESULT_POLL_MS);
    expect(reads).toBe(4);
    expect(clock.pending()).toEqual([UPGRADE_RESULT_POLL_MS]);

    // The Coordinator settled it, and the server already has it: nothing left to poll for.
    config.pending = false;
    await clock.advance(UPGRADE_RESULT_POLL_MS);
    expect(reads).toBe(5);
    expect(clock.pending()).toEqual([]);
  });

  test("a failed send is retried with bounded backoff while the connection stays up", async () => {
    const { clock, transport, acknowledged, reporter } = harness({
      results: [failedResult("request-a")],
    });
    transport.state.failNext = 6;
    await reporter.report();
    const delays: number[] = [];
    while (transport.wire.length === 0) {
      const [delay] = clock.pending();
      expect(delay).toBeDefined();
      delays.push(delay!);
      await clock.advance(delay!);
    }
    expect(delays).toEqual([
      UPGRADE_RESULT_RETRY_BASE_MS,
      UPGRADE_RESULT_RETRY_BASE_MS * 2,
      UPGRADE_RESULT_RETRY_BASE_MS * 4,
      UPGRADE_RESULT_RETRY_BASE_MS * 8,
      UPGRADE_RESULT_RETRY_MAX_MS,
      UPGRADE_RESULT_RETRY_MAX_MS,
    ]);
    expect(UPGRADE_RESULT_RETRY_BASE_MS * 16).toBeGreaterThan(UPGRADE_RESULT_RETRY_MAX_MS);
    expect(acknowledged).toEqual(["request-a"]);
    expect(clock.pending()).toEqual([]);
  });

  test("a failed pass backs off even while an operation is pending, then polls again", async () => {
    const { clock, transport, reporter } = harness({
      results: [failedResult("request-a")],
      pending: true,
    });
    transport.state.failNext = 3;
    await reporter.report();
    const delays: number[] = [];
    while (transport.wire.length === 0) {
      const [delay] = clock.pending();
      delays.push(delay!);
      await clock.advance(delay!);
    }
    expect(delays).toEqual([
      UPGRADE_RESULT_RETRY_BASE_MS,
      UPGRADE_RESULT_RETRY_BASE_MS * 2,
      UPGRADE_RESULT_RETRY_BASE_MS * 4,
    ]);
    expect(clock.pending()).toEqual([UPGRADE_RESULT_POLL_MS]);
  });

  test("a config that cannot be read is retried with backoff", async () => {
    let reads = 0;
    const { clock, transport, acknowledged, reporter } = harness({
      readOperations: async () => {
        reads += 1;
        if (reads === 1) throw new Error("config unreadable");
        return { results: [failedResult("request-a")], pending: false };
      },
    });
    await reporter.report();
    expect(transport.wire).toEqual([]);
    expect(clock.pending()).toEqual([UPGRADE_RESULT_RETRY_BASE_MS]);
    await clock.advance(UPGRADE_RESULT_RETRY_BASE_MS);
    expect(transport.wire.map((result) => result.requestId)).toEqual(["request-a"]);
    expect(acknowledged).toEqual(["request-a"]);
    expect(clock.pending()).toEqual([]);
  });

  test("a result the server accepted but the Coordinator did not acknowledge is not sent again, only acknowledged", async () => {
    let attempts = 0;
    const acknowledged: string[] = [];
    const { clock, transport, reporter } = harness({
      results: [failedResult("request-a")],
      acknowledge: async (requestId) => {
        attempts += 1;
        if (attempts === 1) throw new Error("supervisor socket unavailable");
        acknowledged.push(requestId);
      },
    });
    await reporter.report();
    expect(transport.wire).toHaveLength(1);
    expect(acknowledged).toEqual([]);
    expect(clock.pending()).toEqual([UPGRADE_RESULT_RETRY_BASE_MS]);

    await clock.advance(UPGRADE_RESULT_RETRY_BASE_MS);
    expect(transport.wire).toHaveLength(1);
    expect(acknowledged).toEqual(["request-a"]);
    expect(clock.pending()).toEqual([]);

    // A stale read that still lists it neither sends nor acknowledges it again.
    await reporter.report();
    expect(attempts).toBe(2);
    expect(clock.pending()).toEqual([]);
  });

  test("overlapping triggers run one pass at a time and send each result once", async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let active = 0;
    let maxActive = 0;
    let reads = 0;
    const acknowledgedIds = new Set<string>();
    const { clock, transport, reporter } = harness({
      readOperations: async () => {
        reads += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (reads === 2) await gate;
        active -= 1;
        // First read: the request is still pending, which arms the poll.
        if (reads === 1) return { results: [], pending: true };
        return {
          results: [failedResult("request-a")].filter(
            (result) => !acknowledgedIds.has(result.requestId),
          ),
          pending: false,
        };
      },
      acknowledge: async (requestId) => {
        acknowledgedIds.add(requestId);
      },
    });
    await reporter.report();
    expect(clock.pending()).toEqual([UPGRADE_RESULT_POLL_MS]);
    const ready = reporter.report();
    const tick = clock.advance(UPGRADE_RESULT_POLL_MS);
    const reconnect = reporter.report();
    const accepted = reporter.report();
    expect(reads).toBe(2);
    releaseRead();
    await Promise.all([ready, tick, reconnect, accepted]);
    expect(maxActive).toBe(1);
    // The triggers that arrived mid-pass coalesce into one more pass.
    expect(reads).toBe(3);
    expect(transport.wire.map((result) => result.requestId)).toEqual(["request-a"]);
    expect(clock.pending()).toEqual([]);
  });

  test("a report that fails while disconnected is retried, and a reconnect report settles it", async () => {
    const { clock, transport, acknowledged, reporter } = harness({
      results: [failedResult("request-a")],
    });
    transport.state.connected = false;
    await reporter.report();
    expect(transport.wire).toEqual([]);
    await clock.advance(UPGRADE_RESULT_RETRY_BASE_MS);
    expect(transport.wire).toEqual([]);
    expect(clock.pending()).toEqual([UPGRADE_RESULT_RETRY_BASE_MS * 2]);

    transport.state.connected = true;
    await reporter.report();
    expect(transport.wire.map((result) => result.requestId)).toEqual(["request-a"]);
    expect(acknowledged).toEqual(["request-a"]);
    expect(clock.pending()).toEqual([]);
  });

  test("stop cancels the timer, and a pass in flight or a queued rerun sends nothing afterwards", async () => {
    const { clock, transport, reporter } = harness({
      results: [failedResult("request-a")],
      pending: true,
    });
    transport.state.connected = false;
    await reporter.report();
    expect(clock.pending()).not.toEqual([]);
    reporter.stop();
    expect(clock.pending()).toEqual([]);

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    const gated = harness({
      readOperations: async () => {
        await gate;
        return { results: [failedResult("request-a")], pending: true };
      },
    });
    const pass = gated.reporter.report();
    // A trigger that arrived during the pass is dropped by the stop too.
    const rerun = gated.reporter.report();
    gated.reporter.stop();
    releaseRead();
    await Promise.all([pass, rerun]);
    expect(gated.transport.wire).toEqual([]);
    expect(gated.acknowledged).toEqual([]);
    expect(gated.clock.pending()).toEqual([]);
  });

  test("a stopped reporter ignores triggers until it is started again", async () => {
    const { clock, transport, acknowledged, reporter } = harness({
      results: [failedResult("request-a")],
    });
    reporter.stop();
    await reporter.report();
    expect(transport.wire).toEqual([]);
    expect(clock.pending()).toEqual([]);

    reporter.start();
    await reporter.report();
    expect(transport.wire.map((result) => result.requestId)).toEqual(["request-a"]);
    expect(acknowledged).toEqual(["request-a"]);
  });

  test("a refused request is sent once with its code, and the following pass acknowledges what the Coordinator recorded", async () => {
    const { clock, transport, config, acknowledged, reporter } = harness();
    // The launch failed: the Coordinator recorded the operation as failed before refusing.
    config.results.push(failedResult("request-a"));
    await reporter.reportRefused(failedResult("request-a"));
    await reporter.report();
    expect(transport.wire).toEqual([
      expect.objectContaining({
        requestId: "request-a",
        workspaceId,
        computerId,
        status: "failed",
        errorCode: UPGRADE_ERROR_CODE.UPDATE_INTEGRITY_FAILED,
      }),
    ]);
    expect(acknowledged).toEqual(["request-a"]);
    expect(clock.pending()).toEqual([]);
  });

  test("a refused request whose send fails is not retried", async () => {
    const { clock, transport, reporter } = harness();
    transport.state.failNext = 1;
    await reporter.reportRefused(failedResult("request-a"));
    await reporter.report();
    expect(transport.wire).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });

  test("a transport without upgrade results sends nothing and schedules no retry", async () => {
    const clock = manualClock();
    const acknowledged: string[] = [];
    const reporter = new UpgradeResultReporter({
      workspaceId,
      computerId,
      readOperations: async () => ({ results: [failedResult("request-a")], pending: false }),
      transport: () => ({}),
      acknowledge: async (requestId) => {
        acknowledged.push(requestId);
      },
      schedule: clock.schedule,
    });
    reporter.start();
    await reporter.report();
    expect(acknowledged).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });
});
