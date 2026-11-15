import { expect, test } from "bun:test";
import { Cloud01, Monitor01 } from "@untitledui/icons";

import {
  availableUpdateVersion,
  computerIcon,
  computerLabel,
  computerListUpdateVersion,
  operatingSystemLabel,
} from "#src/features/computers/computer-identity";

test("a cloud Computer never reads as a machine the User controls", () => {
  const cloud = {
    kind: "cloud",
    name: "build-node",
    displayName: "Build Node",
  };

  expect(computerIcon(cloud)).toBe(Cloud01);
  expect(computerLabel(cloud)).toBe("Build Node");
});

test("a local Computer uses its display name rather than machine identity", () => {
  const computer = {
    kind: "local",
    name: "franks-mac",
    displayName: "Frank’s Mac",
  };

  expect(computerIcon(computer)).toBe(Monitor01);
  expect(computerLabel(computer)).toBe("Frank’s Mac");
});

test("an empty display name falls back to the Computer name", () => {
  const fallback = { kind: "local", name: "build-box", displayName: "" };

  expect(computerIcon(fallback)).toBe(Monitor01);
  expect(computerLabel(fallback)).toBe("build-box");
});

test("a cloud Computer offers a newer runtime, and the list names the image when the runtime is current", () => {
  const cloud = {
    kind: "cloud",
    computerVersion: "0.1.7-dev.1",
    imageUpdate: { version: "0.1.8-dev.3" },
  };

  expect(availableUpdateVersion(cloud, "0.1.8-dev.3")).toBe("0.1.8-dev.3");
  expect(computerListUpdateVersion(cloud, "0.1.8-dev.3")).toBe("0.1.8-dev.3");
  expect(computerListUpdateVersion(cloud, "0.1.7-dev.1")).toBe("0.1.8-dev.3");
  expect(computerListUpdateVersion({ ...cloud, imageUpdate: null }, "0.1.7-dev.1")).toBeUndefined();
});

test("a local Computer's update is a newer runtime release", () => {
  const local = { kind: "local", computerVersion: "0.1.7-dev.1" };

  expect(availableUpdateVersion(local, "0.1.8-dev.3")).toBe("0.1.8-dev.3");
  expect(computerListUpdateVersion(local, "0.1.8-dev.3")).toBe("0.1.8-dev.3");
  expect(availableUpdateVersion(local, "0.1.7-dev.1")).toBeUndefined();
});

test("a system the Computer has not reported is left out rather than read as Unknown", () => {
  expect(operatingSystemLabel({ platform: "darwin", osVersion: "15.1" })).toBe("macOS 15.1");
  expect(operatingSystemLabel({ platform: "linux", osVersion: null })).toBe("Linux");
  expect(operatingSystemLabel({ platform: null })).toBeNull();
  expect(operatingSystemLabel({ platform: "freebsd", osVersion: "14" })).toBeNull();
});
