import { expect, test } from "bun:test";
import { DAEMON_STOP_WAIT_MS } from "@lrm/coforge-daemon";
import { CliError } from "#src/errors";
import { stopComputer, type StopComputerHost } from "#src/cli/stop-computer";
import { rejection } from "./rejection";

/** `coforge-computer stop` (task #696, from the #417 acceptance): the person asked for this
 * Computer to be down, so the Coordinator process goes with its Workspaces — a stop that only
 * touches the runtimes leaves the process answering and exits 0 as if it worked. */
type FakeHost = StopComputerHost & { calls: string[] };

/** A Coordinator that answers until `stop()` takes it down — the ordinary case. */
function fakeHost(overrides: Partial<StopComputerHost> = {}, running = true): FakeHost {
  const calls: string[] = [];
  let up = running;
  return {
    calls,
    async assertRestartable() {
      calls.push("assert-restartable");
    },
    async stop() {
      calls.push("stop");
      up = false;
    },
    async isRunning() {
      return up;
    },
    ...overrides,
  };
}

/** Every read costs the whole wait, so a still-answering Coordinator reaches the deadline
 * without the test really sleeping. */
const impatient = (waitMs = 1_000) => {
  let elapsed = 0;
  return {
    waitMs,
    now: () => elapsed,
    sleep: async (milliseconds: number) => {
      elapsed += milliseconds;
    },
  };
};

test("stop takes the Coordinator down through the platform manager", async () => {
  const output: string[] = [];
  const host = fakeHost();

  await stopComputer(host, { stdout: (line) => output.push(line) }, impatient());

  expect(host.calls).toEqual(["assert-restartable", "stop"]);
  expect(output.join("\n")).toContain("CoForge Computer stopped");
});

test("stop records each Workspace stopped before the service goes", async () => {
  // `status` reads the bindings, so they are marked stopped while the Coordinator can still take
  // the request; `start` enables them again.
  const host = fakeHost({
    async stopRuntimes() {
      host.calls.push("runtime-stop");
    },
  });

  await stopComputer(host, { stdout: () => {} }, impatient());

  expect(host.calls).toEqual(["assert-restartable", "runtime-stop", "stop"]);
});

test("a runtime stop that does not answer still lets the service stop", async () => {
  const host = fakeHost({
    async stopRuntimes() {
      host.calls.push("runtime-stop");
      throw new Error("ECONNRESET");
    },
  });

  await stopComputer(host, { stdout: () => {} }, impatient());

  expect(host.calls).toEqual(["assert-restartable", "runtime-stop", "stop"]);
});

test("stop refuses a Computer the platform manager does not run, before stopping anything", async () => {
  const host = fakeHost({
    async assertRestartable() {
      throw new Error("systemd has no coforge-daemon.service unit (LoadState=not-found).");
    },
  });

  const error = await rejection(stopComputer(host, { stdout: () => {} }, impatient()));
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("STOP_OUTSIDE_SERVICE_MANAGER");
  // What the person can do: their own supervisor, not ours.
  expect((error as CliError).hint).toContain("supervisor");
  expect((error as CliError).message).toContain("LoadState=not-found");
  expect(host.calls).toEqual([]);
});

test("stop fails when the Coordinator still answers after its manager stopped it", async () => {
  // The manager accepted the stop and the process kept answering: exactly the exit-0-no-op the
  // #417 acceptance reported.
  const host = fakeHost({
    async stop() {
      host.calls.push("stop");
    },
  });

  const error = await rejection(stopComputer(host, { stdout: () => {} }, impatient()));
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("STOP_NOT_CONFIRMED");
  expect((error as CliError).message).toContain("still answering");
});

test("stop waits as long as the Daemon's own stop can take", async () => {
  // A stop now spends up to the process-tree ladder's 30 s (task #726), so a caller that gave up
  // at the old 10 s would report a stop that was still finishing as a failed one. The default has
  // to be the Daemon's budget, not a number of this CLI's own.
  let elapsed = 0;
  const host = fakeHost({
    async stop() {
      host.calls.push("stop");
    },
  });

  const error = await rejection(
    stopComputer(
      host,
      { stdout: () => {} },
      {
        now: () => elapsed,
        sleep: async (milliseconds: number) => {
          elapsed += milliseconds;
        },
      },
    ),
  );

  expect((error as CliError).code).toBe("STOP_NOT_CONFIRMED");
  expect(elapsed).toBeGreaterThanOrEqual(DAEMON_STOP_WAIT_MS);
  expect(elapsed).toBeLessThan(DAEMON_STOP_WAIT_MS + 1_000);
});

test("stop waits for a Coordinator that needs a moment to go", async () => {
  let reads = 0;
  const host = fakeHost({
    async isRunning() {
      reads += 1;
      return reads === 1;
    },
  });

  await stopComputer(host, { stdout: () => {} }, impatient());

  expect(host.calls).toEqual(["assert-restartable", "stop"]);
  expect(reads).toBe(2);
});

test("stop on a Computer that is not running does nothing and says so", async () => {
  const output: string[] = [];
  const host = fakeHost(
    {
      async assertRestartable() {
        throw new Error("Task Scheduler has no task.");
      },
    },
    false,
  );

  await stopComputer(host, { stdout: (line) => output.push(line) }, impatient());

  expect(host.calls).toEqual([]);
  expect(output.join("\n")).toContain("not running");
});

test("stop takes down a registered service whose process is not answering", async () => {
  // A crash-looping Coordinator is exactly what `stop` must be able to end: the manager knows the
  // service, so the process answering or not is beside the point.
  const host = fakeHost({}, false);

  await stopComputer(host, { stdout: () => {} }, impatient());

  expect(host.calls).toEqual(["assert-restartable", "stop"]);
});

test("stop --json writes one stable result instead of prose", async () => {
  const output: string[] = [];
  const host = fakeHost();

  await stopComputer(host, { stdout: (line) => output.push(line) }, { ...impatient(), json: true });

  expect(JSON.parse(output[0]!)).toEqual({ ok: true, stopped: true });
  expect(output.join("\n")).not.toContain("CoForge Computer stopped");
});
