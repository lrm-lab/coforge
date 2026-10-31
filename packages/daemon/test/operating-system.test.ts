import { expect, test } from "bun:test";
import { detectOperatingSystem, OperatingSystemInfo } from "#src/platform/operating-system";

test("reports macOS product version rather than Darwin kernel version", async () => {
  expect(
    await detectOperatingSystem({
      platform: "darwin",
      release: () => "25.1.0",
      run: async (cmd) => {
        expect(cmd).toEqual(["/usr/bin/sw_vers", "-productVersion"]);
        return "26.1\n";
      },
    }),
  ).toEqual({ platform: "darwin", osVersion: "26.1" });
});

test("failed macOS detection is unknown, never a mislabeled kernel", async () => {
  expect(
    await detectOperatingSystem({
      platform: "darwin",
      release: () => "25.1.0",
      run: async () => {
        throw new Error("missing");
      },
    }),
  ).toEqual({ platform: "darwin", osVersion: "" });
});

test("Linux and Windows report OS release and unsupported systems remain unknown", async () => {
  expect(await detectOperatingSystem({ platform: "linux", release: () => "6.12.9" })).toEqual({
    platform: "linux",
    osVersion: "6.12.9",
  });
  expect(await detectOperatingSystem({ platform: "win32", release: () => "10.0.26100" })).toEqual({
    platform: "win32",
    osVersion: "10.0.26100",
  });
  expect(await detectOperatingSystem({ platform: "freebsd" })).toEqual({
    platform: "",
    osVersion: "",
  });
});

test("the version is read once and reused by every later ready", async () => {
  let reads = 0;
  const info = new OperatingSystemInfo();
  expect(info.current).toEqual({ platform: "", osVersion: "" });
  await info.read({
    platform: "darwin",
    run: async () => {
      reads++;
      return "26.1\n";
    },
  });
  expect(info.current).toEqual({ platform: "darwin", osVersion: "26.1" });
  // A reconnect asks again; nothing spawns, and the answer is already there.
  await info.read({ platform: "darwin", run: async () => "+1" });
  expect(reads).toBe(1);
  expect(info.current).toEqual({ platform: "darwin", osVersion: "26.1" });
});
