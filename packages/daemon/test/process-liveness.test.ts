import { expect, test } from "bun:test";
import { isPidAlive } from "#src/platform/process-liveness";

const statLine = (state: string) =>
  `4242 (worker ) with spaces) ${state} 7 11 13 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654`;
const probe = () => {};

test.each(["Z", "X", "x"])("Linux treats state %s as exited after a successful probe", (state) => {
  expect(
    isPidAlive(4242, {
      platform: "linux",
      probe,
      readStat: (path) => {
        expect(path).toBe("/proc/4242/stat");
        return statLine(state);
      },
    }),
  ).toBe(false);
});

test("Linux keeps a live process and falls back to the probe if procfs cannot confirm its state", () => {
  const platform = "linux";
  expect(isPidAlive(4242, { platform, probe, readStat: () => statLine("S") })).toBe(true);
  expect(isPidAlive(4242, { platform, probe, readStat: () => "4242 (worker) Z" })).toBe(true);
  expect(
    isPidAlive(4242, {
      platform,
      probe,
      readStat: () => {
        throw new Error("procfs is unavailable");
      },
    }),
  ).toBe(true);
});

test("macOS checks the PID without reading procfs", () => {
  let read = false;
  expect(
    isPidAlive(4242, {
      platform: "darwin",
      probe,
      readStat: () => {
        read = true;
        return statLine("Z");
      },
    }),
  ).toBe(true);
  expect(read).toBe(false);
});

test("a missing PID is dead and callers retain their handling of other probe errors", () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
  const probe = () => {
    throw denied;
  };
  expect(
    isPidAlive(4242, {
      probe: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
      probeError: "throw",
    }),
  ).toBe(false);
  expect(isPidAlive(4242, { probe })).toBe(false);
  expect(isPidAlive(4242, { probe, probeError: "alive" })).toBe(true);
  expect(() => isPidAlive(4242, { probe, probeError: "throw" })).toThrow(denied);
});
