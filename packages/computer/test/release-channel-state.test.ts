import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  DEFAULT_RELEASE_CHANNEL,
  parseReleaseChannel,
  readReleaseChannel,
  writeReleaseChannel,
} from "#src/release/channel-state";
import { resolveReleaseFeedForChannel } from "#src/release-channel";

test("channel selectors match the Raft vocabulary and reject unsafe values", () => {
  expect(parseReleaseChannel("latest")).toBe("latest");
  expect(parseReleaseChannel("alpha")).toBe("alpha");
  expect(parseReleaseChannel("pinned:1.2.3-beta.1")).toBe("pinned:1.2.3-beta.1");
  expect(parseReleaseChannel("constructed-wake-context")).toBe("constructed-wake-context");
  expect(parseReleaseChannel("pinned:../etc")).toBeNull();
  expect(parseReleaseChannel("Stable")).toBeNull();
  expect(parseReleaseChannel("main")).toBeNull();
});

test("missing or corrupt state falls back to latest, and writes are atomic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-channel-state-"));
  expect(await readReleaseChannel(directory)).toBe(DEFAULT_RELEASE_CHANNEL);
  await writeFile(join(directory, "release-channel"), "not a channel\n");
  expect(await readReleaseChannel(directory)).toBe(DEFAULT_RELEASE_CHANNEL);
  await writeReleaseChannel(directory, "alpha");
  expect(await readReleaseChannel(directory)).toBe("alpha");
  expect(await readFile(join(directory, "release-channel"), "utf8")).toBe("alpha\n");
});

test("only feeds present in the current distribution contract can be selected", () => {
  expect(resolveReleaseFeedForChannel("latest")).toBe("https://releases.coforge.cn/");
  expect(resolveReleaseFeedForChannel("alpha")).toBe("https://releases-staging.coforge.cn");
  expect(resolveReleaseFeedForChannel("pinned:1.2.3")).toBe("https://releases.coforge.cn/");
  expect(() => resolveReleaseFeedForChannel("constructed-wake-context")).toThrow(
    /not published by the CoForge feed/,
  );
});
