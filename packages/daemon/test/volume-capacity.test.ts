import { describe, expect, test } from "bun:test";
import {
  mergeImportantAvailableBytes,
  parseMacosImportantCapacityOutput,
  readMacosImportantAvailableBytes,
  readVolumeCapacity,
} from "#src/platform/volume-capacity";
import { readDiskStatus, type MachineStatusIo } from "#src/platform/machine-status";

const GIB = 1024 ** 3;

describe("volume-capacity", () => {
  test("parses positive finite integer byte counts from osascript output", async () => {
    expect(parseMacosImportantCapacityOutput("64424509440\n")).toBe(60 * GIB);
    expect(parseMacosImportantCapacityOutput("0")).toBe(0);
    expect(parseMacosImportantCapacityOutput("")).toBeUndefined();
    expect(parseMacosImportantCapacityOutput("-10")).toBeUndefined();
    expect(parseMacosImportantCapacityOutput("undefined\n")).toBeUndefined();
    expect(parseMacosImportantCapacityOutput("123.45")).toBeUndefined();
    expect(parseMacosImportantCapacityOutput("9007199254740992")).toBeUndefined();
    expect(await readMacosImportantAvailableBytes("")).toBeUndefined();
    expect(
      mergeImportantAvailableBytes(
        { availableBytes: 5 * GIB, totalBytes: 100 * GIB },
        10 * GIB + 0.5,
      ),
    ).toEqual({ availableBytes: 5 * GIB, totalBytes: 100 * GIB });
  });

  test("supplements statfs with macOS important-usage capacity capped at totalBytes", async () => {
    const capacity = await readVolumeCapacity("/Users/demo", {
      platform: "darwin",
      readStatfs: async () => ({ availableBytes: 8 * GIB, totalBytes: 500 * GIB }),
      readMacosImportantBytes: async () => 85 * GIB,
    });
    expect(capacity).toEqual({ availableBytes: 85 * GIB, totalBytes: 500 * GIB });

    const capped = await readVolumeCapacity("/Users/demo", {
      platform: "darwin",
      readStatfs: async () => ({ availableBytes: 8 * GIB, totalBytes: 100 * GIB }),
      readMacosImportantBytes: async () => 120 * GIB,
    });
    expect(capped).toEqual({ availableBytes: 100 * GIB, totalBytes: 100 * GIB });
  });

  test("falls back to statfs when macOS probe fails or returns less, and skips probe off darwin", async () => {
    const failed = await readVolumeCapacity("/Users/demo", {
      platform: "darwin",
      readStatfs: async () => ({ availableBytes: 12 * GIB, totalBytes: 256 * GIB }),
      readMacosImportantBytes: async () => {
        throw new Error("osascript timed out");
      },
    });
    expect(failed).toEqual({ availableBytes: 12 * GIB, totalBytes: 256 * GIB });

    const lower = await readVolumeCapacity("/Users/demo", {
      platform: "darwin",
      readStatfs: async () => ({ availableBytes: 30 * GIB, totalBytes: 256 * GIB }),
      readMacosImportantBytes: async () => 10 * GIB,
    });
    expect(lower).toEqual({ availableBytes: 30 * GIB, totalBytes: 256 * GIB });

    let probeCalled = false;
    const linux = await readVolumeCapacity("/home/demo", {
      platform: "linux",
      readStatfs: async () => ({ availableBytes: 15 * GIB, totalBytes: 256 * GIB }),
      readMacosImportantBytes: async () => {
        probeCalled = true;
        return 90 * GIB;
      },
    });
    expect(probeCalled).toBe(false);
    expect(linux).toEqual({ availableBytes: 15 * GIB, totalBytes: 256 * GIB });
  });

  test("readDiskStatus merges optional importantDiskAvailableBytes", async () => {
    const io: MachineStatusIo = {
      readFile: async () => "",
      disk: () => ({ availableBytes: 5 * GIB, totalBytes: 200 * GIB }),
      importantDiskAvailableBytes: async () => 45 * GIB,
      totalMemory: () => 16 * GIB,
      freeMemory: () => 8 * GIB,
      vmStat: async () => undefined,
    };
    expect(await readDiskStatus("/agents", io)).toEqual({
      availableBytes: 45 * GIB,
      totalBytes: 200 * GIB,
    });
  });
});
