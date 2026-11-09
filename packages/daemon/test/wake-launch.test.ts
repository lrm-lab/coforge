import { expect, test } from "bun:test";
import { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import { beginWakeLaunch } from "#src/daemon-runtime/wake-launch";

const THREE_HOURS = 3 * 60 * 60 * 1000;

test("a wake that names a recovery duration waits until then", async () => {
  const failures = new LaunchFailureBackoff();
  const launches = new Set<string>();
  const started = Date.now();
  const launch = beginWakeLaunch(
    "agent-a",
    Promise.reject(new Error("You've reached your weekly usage limit. Resets in 3h (3:45pm).")),
    launches,
    failures,
  );
  await expect(launch).rejects.toThrow("Resets in 3h");
  // The in-flight mark clears on the detached chain, one turn after the rejection is observed.
  await Promise.resolve();
  expect(launches.has("agent-a")).toBe(false);
  const until = failures.blockedUntil("agent-a");
  expect(until).toBeDefined();
  const wait = (until ?? 0) - started;
  expect(wait).toBeGreaterThanOrEqual(THREE_HOURS - 1_000);
  expect(wait).toBeLessThanOrEqual(THREE_HOURS + 1_000);
  expect(failures.attempts("agent-a")).toBe(1);
});

test("only a wake that waits on a recovery time leaves a cooldown a lifted limit can end", async () => {
  const failures = new LaunchFailureBackoff();
  await expect(
    beginWakeLaunch(
      "quota",
      Promise.reject(new Error("You've reached your weekly usage limit. Resets in 3h (3:45pm).")),
      new Set(),
      failures,
    ),
  ).rejects.toThrow("Resets in 3h");
  await expect(
    beginWakeLaunch("plain", Promise.reject(new Error("spawn blew up")), new Set(), failures),
  ).rejects.toThrow("spawn blew up");

  expect(failures.endRecoveryWaits(() => true)).toBe(1);

  expect(failures.isBlocked("quota")).toBe(false);
  expect(failures.isBlocked("plain")).toBe(true);
});

test("a second quota wake waits the recovery time again", async () => {
  const failures = new LaunchFailureBackoff();
  const message = "You've hit your usage limit. try again in 5 hours.";
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    await expect(
      beginWakeLaunch("agent-a", Promise.reject(new Error(message)), new Set(), failures),
    ).rejects.toThrow("usage limit");
    const wait = (failures.blockedUntil("agent-a") ?? 0) - started;
    expect(wait).toBeGreaterThanOrEqual(5 * 60 * 60 * 1000 - 1_000);
    expect(wait).toBeLessThanOrEqual(5 * 60 * 60 * 1000 + 1_000);
  }
  expect(failures.attempts("agent-a")).toBe(2);
});

test("a wake with no recovery time keeps the short cooldown", async () => {
  const failures = new LaunchFailureBackoff();
  const started = Date.now();
  await expect(
    beginWakeLaunch(
      "agent-a",
      Promise.reject(new Error("You've hit your usage limit.")),
      new Set(),
      failures,
    ),
  ).rejects.toThrow("usage limit");
  const wait = (failures.blockedUntil("agent-a") ?? 0) - started;
  expect(wait).toBeGreaterThanOrEqual(900);
  expect(wait).toBeLessThanOrEqual(1_500);
});

test("a session limit and a stack overflow do not wait for a quota reset", async () => {
  for (const message of ["You've hit your session limit", "Maximum call stack size exceeded"]) {
    const failures = new LaunchFailureBackoff();
    const started = Date.now();
    await expect(
      beginWakeLaunch("agent-a", Promise.reject(new Error(message)), new Set(), failures),
    ).rejects.toThrow(message);
    const wait = (failures.blockedUntil("agent-a") ?? 0) - started;
    expect(wait).toBeLessThanOrEqual(1_500);
  }
});

test("a wake that starts does not record a failure", async () => {
  const failures = new LaunchFailureBackoff();
  const launches = new Set<string>();
  const launch = beginWakeLaunch("agent-a", Promise.resolve("ok"), launches, failures);
  expect(launches.has("agent-a")).toBe(true);
  await expect(launch).resolves.toBe("ok");
  await Promise.resolve();
  expect(launches.has("agent-a")).toBe(false);
  expect(failures.attempts("agent-a")).toBe(0);
  expect(failures.isBlocked("agent-a")).toBe(false);
});
