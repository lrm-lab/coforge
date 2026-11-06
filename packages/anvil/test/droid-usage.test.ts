import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { UsageReauthRequiredError, UsageUnavailableError } from "#src/contract";
import {
  DROID_USAGE_SCREEN,
  parseDroidLimitsScreens,
  readDroidUsage,
  type DroidUsageHost,
} from "#src/droid/usage";
import type { DroidAuthProcess } from "#src/droid/auth";
import { VtScreen } from "#src/droid/vt-screen";

const FIXTURES = new URL("./fixtures/droid-usage/", import.meta.url);
const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const encoder = new TextEncoder();

async function screenLines(name: string): Promise<string[]> {
  const text = await readFile(new URL(`${name}.txt`, FIXTURES), "utf8");
  return text.split("\n").slice(0, DROID_USAGE_SCREEN.rows);
}

async function realScreens(): Promise<string[][]> {
  return Promise.all(["standard", "droid-core", "extra-usage"].map((name) => screenLines(name)));
}

test("parseDroidLimitsScreens reads the three real /limits captures", async () => {
  const snapshot = parseDroidLimitsScreens(await realScreens(), NOW);
  expect(snapshot.provider).toBe(RUNTIME_PROVIDER.DROID);
  expect(snapshot.officialDescription).toBe("You are using Standard Usage.");
  expect(snapshot.health).toBe("ok");
  expect(snapshot.officialGroups).toHaveLength(3);

  const [standard, core, extra] = snapshot.officialGroups!;
  expect(standard!.name).toBe("Standard");
  expect(standard!.buckets.map((bucket) => bucket.window)).toEqual(["5h", "weekly", "monthly"]);
  const fiveHour = standard!.buckets[0]!;
  expect(fiveHour.usedPercent).toBe(1);
  expect(fiveHour.status).toBe("ok");
  expect(fiveHour.windowDurationMinutes).toBe(300);
  expect(fiveHour.resetsAt).toBe(new Date(NOW + (2 * 3_600_000 + 32 * 60_000)).toISOString());
  expect(standard!.buckets[1]!.resetsAt).toBe(new Date(NOW + 5 * 86_400_000).toISOString());
  expect(standard!.buckets[2]!.resetsAt).toBe(new Date(NOW + 28 * 86_400_000).toISOString());

  // The active pool's 5-hour and weekly windows stay the two-window summary.
  expect(snapshot.primary?.usedPercent).toBe(1);
  expect(snapshot.primary?.windowDurationMinutes).toBe(300);
  expect(snapshot.secondary?.usedPercent).toBe(1);
  expect(snapshot.secondary?.windowDurationMinutes).toBe(10_080);

  // An untouched pool reports 0% with no reset, marked as not started.
  expect(core!.name).toBe("Droid Core");
  for (const bucket of core!.buckets) {
    expect(bucket.usedPercent).toBe(0);
    expect(bucket.resetsAt).toBeUndefined();
    expect(bucket.description).toBe("Not started");
  }

  // Extra Usage is a prepaid dollar balance, not a window.
  expect(extra!.name).toBe("Extra Usage");
  expect(extra!.buckets).toHaveLength(1);
  expect(extra!.buckets[0]!.name).toBe("Balance");
  expect(extra!.buckets[0]!.description).toBe("$0.00 remaining");
  expect(extra!.buckets[0]!.usedPercent).toBeUndefined();
});

test("parseDroidLimitsScreens refuses malformed panels instead of guessing", async () => {
  const cases: Array<[string, () => Promise<string[][]>]> = [
    ["no screens", async () => []],
    [
      "missing panel header",
      async () => [
        (await screenLines("standard")).filter((line) => !line.includes("Usage & Limits")),
      ],
    ],
    [
      "missing window row",
      async () => [
        (await screenLines("standard")).map((line) => line.replace("Weekly   1%", "Weekly   %")),
      ],
    ],
    [
      "percent above 100",
      async () => [
        (await screenLines("standard")).map((line) => line.replace("Monthly  1%", "Monthly  101%")),
      ],
    ],
    [
      "unreadable balance",
      async () => [
        (await screenLines("extra-usage")).map((line, index) =>
          index === 25 ? line.replace("$0.00 remaining", "balance pending") : line,
        ),
      ],
    ],
    [
      "tab bar unreadable",
      async () => [
        (await screenLines("standard")).map((line) =>
          line.replaceAll("◉", " ").replaceAll("○", " "),
        ),
      ],
    ],
  ];
  for (const [name, make] of cases) {
    const screens = await make();
    expect(() => parseDroidLimitsScreens(screens, NOW), name).toThrow(UsageUnavailableError);
  }
});

test("VtScreen reproduces the real 160x40 panel frames", async () => {
  // Each fixture is one settled pool's repaint, gzipped for the size ratchet; replaying it
  // into a fresh screen must yield that pool's complete panel.
  const probes: Array<[string, string[]]> = [
    ["standard", ["◉ Standard", "5-hour   1%", "↻", "You are using Standard Usage."]],
    ["droid-core", ["◉ Droid Core", "5-hour   0%", "Use Droid to start"]],
    ["extra-usage", ["◉ Extra Usage", "Balance", "$0.00 remaining"]],
  ];
  for (const [name, needles] of probes) {
    const screen = new VtScreen(DROID_USAGE_SCREEN);
    screen.write(new TextDecoder().decode(await fixtureBytes(`${name}`)));
    const text = screen.lines().join("\n");
    for (const needle of needles) expect(text, `${name}: ${needle}`).toContain(needle);
  }
});

/** A scripted `droid` TUI: a boot greeting at spawn, `commandResponse` (or the first panel) on
 * `/limits`, then each pool capture in order on every Tab — cycling back to the first pool ends
 * the reader's capture loop exactly like the real panel. */
function scriptedDroid(
  panels: readonly Uint8Array[],
  commandResponse?: Uint8Array,
): { process: DroidAuthProcess; writes: string[]; isDisposed(): boolean } {
  const writes: string[] = [];
  let disposed = false;
  let panel = -1;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const exited = Promise.withResolvers<number>();
  const output = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(encoder.encode("\x1b[2J\x1b[Hcoforge test droid\n"));
    },
  });
  const emit = (bytes: Uint8Array) => {
    if (!disposed) controller.enqueue(bytes);
  };
  const process: DroidAuthProcess = {
    output,
    exited: exited.promise,
    write(text: string) {
      writes.push(text);
      if (text === "/limits\r") {
        panel = 0;
        const response = commandResponse ?? panels[0];
        if (response) emit(response);
      } else if (text === "\t" && panels.length > 0) {
        panel = (panel + 1) % panels.length;
        emit(panels[panel]!);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      exited.resolve(0);
      controller.close();
    },
  };
  return { process, writes, isDisposed: () => disposed };
}

async function fixtureBytes(name: string): Promise<Uint8Array> {
  const gz = await Bun.file(new URL(`${name}.bin.gz`, FIXTURES)).bytes();
  return new Uint8Array(Bun.gunzipSync(gz));
}

test("readDroidUsage drives the TUI through /limits and every pool Tab", async () => {
  // Each frame is the repaint the real TUI emits for that pool transition, in order: the
  // Standard panel on /limits, then Droid Core, Extra Usage, and back to Standard on Tabs.
  const frames = await Promise.all([
    fixtureBytes("standard"),
    fixtureBytes("droid-core"),
    fixtureBytes("extra-usage"),
    fixtureBytes("standard-return"),
  ]);
  const fake = scriptedDroid(frames);
  const host: DroidUsageHost = { spawn: () => fake.process };
  const snapshot = await readDroidUsage({ workingDirectory: "/tmp", timeoutMs: 45_000 }, host);
  expect(snapshot.officialGroups).toHaveLength(3);
  expect(snapshot.officialGroups!.map((group) => group.name)).toEqual([
    "Standard",
    "Droid Core",
    "Extra Usage",
  ]);
  expect(snapshot.primary?.usedPercent).toBe(1);
  expect(fake.writes[0]).toBe("/limits\r");
  expect(fake.writes.filter((write) => write === "\t")).toHaveLength(3);
  expect(fake.writes.at(-1)).toBe("\x1b");
  expect(fake.isDisposed()).toBe(true);
}, 20_000);

test("readDroidUsage classifies a signed-out TUI as reauth", async () => {
  const login = encoder.encode("\x1b[2J\x1b[HSign in to Factory to continue\n");
  const fake = scriptedDroid([], login);
  const host: DroidUsageHost = { spawn: () => fake.process };
  await expect(
    readDroidUsage({ workingDirectory: "/tmp", timeoutMs: 45_000 }, host),
  ).rejects.toBeInstanceOf(UsageReauthRequiredError);
  expect(fake.isDisposed()).toBe(true);
}, 20_000);

test("readDroidUsage reports spawn and early-exit failures as unavailable", async () => {
  const reasons: string[] = [];
  const failing: DroidUsageHost = {
    spawn: () => {
      throw new Error("no such file");
    },
    logFailure: (reason) => reasons.push(reason),
  };
  await expect(
    readDroidUsage({ workingDirectory: "/tmp", timeoutMs: 45_000 }, failing),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
  expect(reasons).toEqual(["spawn_failed"]);

  const exited = Promise.withResolvers<number>();
  exited.resolve(1);
  const dead: DroidAuthProcess = {
    output: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited: exited.promise,
    write() {},
    async dispose() {},
  };
  const deadHost: DroidUsageHost = {
    spawn: () => dead,
    logFailure: (reason) => reasons.push(reason),
  };
  await expect(
    readDroidUsage({ workingDirectory: "/tmp", timeoutMs: 45_000 }, deadHost),
  ).rejects.toBeInstanceOf(UsageUnavailableError);
  expect(reasons).toContain("process_exited");
});
