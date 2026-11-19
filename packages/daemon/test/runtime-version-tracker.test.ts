import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-probe";
import {
  compareSemver,
  readRuntimeCliDowngrades,
  recordRuntimeCliObservations,
  runtimeCliVersionsPath,
} from "#src/code-agent/runtime-version-tracker";
import {
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
} from "#src/supervisor/workspace-health-journal";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("runtime CLI accidental-downgrade tracker", () => {
  test("compareSemver compares strict major.minor.patch versions and ignores prereleases", () => {
    expect(compareSemver("2.1.45", "2.1.44")).toBeGreaterThan(0);
    expect(compareSemver("v2.1.45", "2.1.45")).toBe(0);
    expect(compareSemver("2.0.10", "2.1.45")).toBeLessThan(0);
    expect(compareSemver("2.1.45-rc.1", "2.1.45")).toBeUndefined();
    expect(compareSemver("dev-build", "2.1.45")).toBeUndefined();
  });

  test("tracks highest observed version, flags accidental downgrade once, and clears on recovery", async () => {
    const dir = await makeTempDir("coforge-cli-version-tracker-");
    let nowMs = Date.parse("2026-04-01T10:00:00.000Z");
    const now = () => new Date(nowMs);

    const initial = await recordRuntimeCliObservations(
      dir,
      [{ provider: "claude_code", version: "2.1.45", executablePath: "/opt/homebrew/bin/claude" }],
      now,
    );
    expect(initial).toEqual([]);
    expect(await readRuntimeCliDowngrades(dir)).toEqual([]);

    nowMs += 60_000;
    const downgraded = await recordRuntimeCliObservations(
      dir,
      [{ provider: "claude_code", version: "2.0.10", executablePath: "/usr/local/bin/claude" }],
      now,
    );
    expect(downgraded).toEqual([
      {
        provider: "claude_code",
        previousVersion: "2.1.45",
        currentVersion: "2.0.10",
        previousPath: "/opt/homebrew/bin/claude",
        currentPath: "/usr/local/bin/claude",
        detectedAt: "2026-04-01T10:01:00.000Z",
      },
    ]);
    expect(await readRuntimeCliDowngrades(dir)).toEqual(downgraded);

    nowMs += 60_000;
    const repeated = await recordRuntimeCliObservations(
      dir,
      [{ provider: "claude_code", version: "2.0.10", executablePath: "/usr/local/bin/claude" }],
      now,
    );
    expect(repeated).toEqual([]);
    expect(await readRuntimeCliDowngrades(dir)).toEqual(downgraded);

    nowMs += 60_000;
    const recovered = await recordRuntimeCliObservations(
      dir,
      [{ provider: "claude_code", version: "2.1.45", executablePath: "/opt/homebrew/bin/claude" }],
      now,
    );
    expect(recovered).toEqual([]);
    expect(await readRuntimeCliDowngrades(dir)).toEqual([]);
  });

  test("ignores corrupt state files and unparseable versions", async () => {
    const dir = await makeTempDir("coforge-cli-version-corrupt-");
    await writeFile(runtimeCliVersionsPath(dir), "{not-valid-json");
    expect(await readRuntimeCliDowngrades(dir)).toEqual([]);

    const downgraded = await recordRuntimeCliObservations(dir, [
      { provider: "codex", version: "0.115.0-beta.1", executablePath: "/usr/bin/codex" },
    ]);
    expect(downgraded).toEqual([]);
    expect(await readRuntimeCliDowngrades(dir)).toEqual([]);
  });

  test("discoverExternalCodeAgents records runtime CLI downgrades in cacheDirectory", async () => {
    const dir = await makeTempDir("coforge-cli-probe-downgrade-");
    const goodBin = join(dir, "claude-good");
    const oldBin = join(dir, "claude-old");
    await writeFile(goodBin, "v2");
    await writeFile(oldBin, "v1");
    await utimes(oldBin, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    let activePath = goodBin;
    let activeVersion = "2.1.45 (Claude Code)";
    const probe = {
      which: () => undefined,
      exists: async () => true,
      resolve: async (provider: string) =>
        provider === RUNTIME_PROVIDER.CLAUDE_CODE ? activePath : undefined,
      spawn: () => ({
        stdout: new Response(`${activeVersion}\n`).body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        kill: () => {},
      }),
    };

    const first = await discoverExternalCodeAgents(
      probe,
      {},
      "linux",
      RUNTIME_PROVIDER.CLAUDE_CODE,
      dir,
    );
    expect(first[0]?.version).toBe("2.1.45");
    expect(await readRuntimeCliDowngrades(dir)).toEqual([]);

    activePath = oldBin;
    activeVersion = "2.0.10 (Claude Code)";
    const second = await discoverExternalCodeAgents(
      probe,
      {},
      "linux",
      RUNTIME_PROVIDER.CLAUDE_CODE,
      dir,
    );
    expect(second[0]?.version).toBe("2.0.10");

    const downgrades = await readRuntimeCliDowngrades(dir);
    expect(downgrades).toHaveLength(1);
    expect(downgrades[0]).toMatchObject({
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      previousVersion: "2.1.45",
      currentVersion: "2.0.10",
      previousPath: goodBin,
      currentPath: oldBin,
    });
  });
  test("heals array providers, non-semver entries, normalizes v-prefix, and handles concurrent updates", async () => {
    const dir = await makeTempDir("coforge-cli-version-edge-");
    await writeFile(
      runtimeCliVersionsPath(dir),
      JSON.stringify({ schemaVersion: 1, providers: [] }),
    );
    await recordRuntimeCliObservations(dir, [
      { provider: "claude_code", version: "v2.1.45", executablePath: "/opt/bin/claude" },
    ]);
    const downgraded = await recordRuntimeCliObservations(dir, [
      { provider: "claude_code", version: " 2.0.10 ", executablePath: "/usr/bin/claude" },
    ]);
    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]?.previousVersion).toBe("2.1.45");
    expect(downgraded[0]?.currentVersion).toBe("2.0.10");

    const normalizedRepeat = await recordRuntimeCliObservations(dir, [
      { provider: "claude_code", version: "v2.0.10", executablePath: "/usr/bin/claude" },
    ]);
    expect(normalizedRepeat).toEqual([]);

    const furtherDowngrade = await recordRuntimeCliObservations(dir, [
      { provider: "claude_code", version: "1.9.0", executablePath: "/usr/bin/claude" },
    ]);
    expect(furtherDowngrade).toHaveLength(1);
    expect(furtherDowngrade[0]?.currentVersion).toBe("1.9.0");

    await writeFile(
      runtimeCliVersionsPath(dir),
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          codex: {
            highestVersion: "not-semver",
            highestPath: "/bin/codex",
            highestObservedAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
    );
    await Promise.all([
      recordRuntimeCliObservations(dir, [
        { provider: "codex", version: "0.115.0", executablePath: "/opt/bin/codex" },
      ]),
      recordRuntimeCliObservations(dir, [
        { provider: "gemini", version: "1.2.3", executablePath: "/opt/bin/gemini" },
      ]),
    ]);
    expect(await readRuntimeCliDowngrades(dir)).toEqual([]);
  });
});

describe("WorkspaceHealthJournal crash history", () => {
  test("prunes stale crashes outside window, respects parked state, and reports degraded latch", async () => {
    const dir = await makeTempDir("coforge-crash-history-");
    let nowMs = Date.parse("2026-04-01T12:00:00.000Z");
    const journal = new WorkspaceHealthJournal(workspaceHealthJournalPath(dir), () => nowMs);

    expect(await journal.recentCrashes()).toEqual({ recentCrashes: [] });

    await journal.recordCrash(nowMs);
    nowMs += 10_000;
    await journal.recordCrash(nowMs);

    expect(await journal.state()).toEqual({ status: "ok" });
    expect(await journal.recentCrashes()).toEqual({
      recentCrashes: ["2026-04-01T12:00:00.000Z", "2026-04-01T12:00:10.000Z"],
    });

    nowMs += 120_000;
    expect(await journal.recentCrashes()).toEqual({ recentCrashes: [] });

    await journal.recordCrash(nowMs);
    nowMs += 10_000;
    await journal.recordCrash(nowMs);
    nowMs += 10_000;
    await journal.recordCrash(nowMs);
    expect(await journal.recentCrashes()).toMatchObject({
      recentCrashes: [
        "2026-04-01T12:02:10.000Z",
        "2026-04-01T12:02:20.000Z",
        "2026-04-01T12:02:30.000Z",
      ],
      degradedAt: "2026-04-01T12:02:30.000Z",
      degradedCrashCount: 3,
    });

    await journal.markParked("workspace_deleted");
    expect(await journal.recentCrashes()).toEqual({ recentCrashes: [] });
  });
});
