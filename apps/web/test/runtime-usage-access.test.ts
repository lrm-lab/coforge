import { expect, test } from "bun:test";
import { PrismaRuntimeAuthAuthorization } from "#src/server/computers/runtime-auth-authorization.server";
import { RuntimeUsageAccess } from "#src/server/computers/runtime-usage-access.server";
import type { UsageReadResult, UsageSnapshot } from "#src/server/centrifugo/usage-cache.server";

const scope = { workspaceId: "w", computerId: "c", provider: "codex" as const };
const principal = { userId: "u", workspaceId: "w" };
const reading = { state: "fresh" } as unknown as UsageReadResult;

/** A Codex reading as the cache holds it, with every field the popover draws and the ones it
 * does not: the balance string, the time of the last attempt and a failure's message. */
function fullReading(status: "available" | "unsupported" = "available"): UsageReadResult {
  return {
    state: "fresh",
    pendingScanId: "scan-2",
    result: {
      ...scope,
      scanId: "scan-1",
      status,
      message: "Usage reader is not connected yet",
      collectedAt: "2026-09-17T00:00:00Z",
      lastAttemptAt: "2026-09-17T00:01:00Z",
      snapshot: {
        provider: "codex",
        planType: "pro",
        accountLabel: "a***@example.com",
        health: "ok",
        primary: { usedPercent: 40, windowDurationMinutes: 300, resetsAt: "2026-09-17T05:00:00Z" },
        officialDescription: "Official note",
        officialGroups: [
          { name: "Codex", description: "Group note", buckets: [{ id: "b", window: "credit" }] },
        ],
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        creditUsage: { used: 7, limit: 10, overage: 1 },
        resetCreditsAvailable: 2,
        collectedAt: "2026-09-17T00:00:00Z",
        // A field a newer Computer reports that no popover draws yet.
        futureField: "not for viewers",
      } as UsageSnapshot,
    },
  };
}

type Connection = { ownerId: string; role: string | undefined } | undefined;

/** The real who-may-manage rule (hidden default cloud Computers included) over a Computer
 * connection row, played the way `runtime-auth-authorization.test.ts` plays it, with the usage
 * cache and the scan publisher recorded. */
function access(
  connection: Connection,
  options: {
    runtimeInstalled?: boolean;
    cached?: UsageReadResult;
    computer?: { kind: string; cloudSlot: string | null };
    /** The runtime row's `isPublic`; public by default. */
    isPublic?: boolean;
    unavailableCode?: string | null;
  } = {},
) {
  const calls: string[] = [];
  const usage = new RuntimeUsageAccess({
    authorization: new PrismaRuntimeAuthAuthorization({
      workspaceComputer: {
        findFirst: async () =>
          connection && {
            computer: {
              kind: "local",
              cloudSlot: null,
              ...options.computer,
              ownerId: connection.ownerId,
            },
            workspace: { members: connection.role ? [{ role: connection.role }] : [] },
          },
      },
    } as never),
    runtimes: {
      findInWorkspace: async () =>
        options.runtimeInstalled === false
          ? undefined
          : ({
              ownerId: connection?.ownerId ?? "",
              isPublic: options.isPublic ?? true,
              unavailableCode: options.unavailableCode ?? null,
            } as never),
    },
    readCache: async () => {
      calls.push("read");
      return options.cached ?? reading;
    },
    startScan: async () => {
      calls.push("scan");
      return "scan-1";
    },
  });
  return { usage, calls };
}

const computerOwner = { ownerId: "u", role: "member" };
const workspaceAdmin = { ownerId: "x", role: "admin" };
const workspaceOwner = { ownerId: "x", role: "owner" };
const plainMember = { ownerId: "x", role: "member" };

test("the Computer's owner, and a Workspace owner or admin, read and scan a runtime's usage", async () => {
  for (const connection of [computerOwner, workspaceAdmin, workspaceOwner]) {
    const { usage, calls } = access(connection);
    expect(await usage.read(principal, scope)).toBe(reading);
    expect(await usage.scan(principal, scope)).toEqual({ scanId: "scan-1", status: "pending" });
    expect(calls).toEqual(["read", "scan"]);
  }
});

test("a plain Workspace member neither reads nor scans, and reaches neither the cache nor the Computer", async () => {
  const { usage, calls } = access(plainMember);
  await expect(usage.read(principal, scope)).rejects.toThrow("runtime is not available");
  await expect(usage.scan(principal, scope)).rejects.toThrow("runtime is not available");
  expect(calls).toEqual([]);
});

test("a Computer not connected to the Workspace, and a role the server does not know, get nothing", async () => {
  for (const connection of [
    undefined,
    { ownerId: "x", role: "weird" },
    { ownerId: "x", role: undefined },
  ]) {
    const { usage, calls } = access(connection);
    await expect(usage.read(principal, scope)).rejects.toThrow("runtime is not available");
    await expect(usage.scan(principal, scope)).rejects.toThrow("runtime is not available");
    expect(calls).toEqual([]);
  }
});

test("a runtime the Computer has not reported is not available, even to who may manage the Computer", async () => {
  const { usage, calls } = access(workspaceAdmin, { runtimeInstalled: false });
  await expect(usage.read(principal, scope)).rejects.toThrow("runtime is not available");
  await expect(usage.scan(principal, scope)).rejects.toThrow("runtime is not available");
  expect(calls).toEqual([]);
});

test("the Computer's owner reads the whole cached reading", async () => {
  const cached = fullReading();
  const { usage } = access(computerOwner, { cached });
  expect(await usage.read(principal, scope)).toEqual(cached);
});

test("a Workspace owner or admin who does not own the Computer reads what the popover draws, and not the credit balance", async () => {
  for (const connection of [workspaceAdmin, workspaceOwner]) {
    const cached = fullReading();
    const read = await access(connection, { cached }).usage.read(principal, scope);
    const { balance: _balance, ...credits } = cached.result!.snapshot!.credits!;
    const { lastAttemptAt: _attempt, message: _message, ...result } = cached.result!;
    const {
      futureField: _future,
      collectedAt: _observed,
      ...snapshot
    } = cached.result!.snapshot as UsageSnapshot & { futureField: string };
    expect(read).toEqual({
      ...cached,
      result: { ...result, snapshot: { ...snapshot, credits } },
    });
    expect(JSON.stringify(read)).not.toContain("not for viewers");
    // Everything the popover draws, the reset credit count and the account label included.
    expect(read.result?.snapshot).toMatchObject({
      planType: "pro",
      accountLabel: "a***@example.com",
      resetCreditsAvailable: 2,
      creditUsage: { used: 7, limit: 10, overage: 1 },
      officialDescription: "Official note",
      credits: { hasCredits: true, unlimited: false },
    });
    expect(JSON.stringify(read)).not.toContain("12.50");
    // The cache's own object is untouched, so the owner's next read still has the balance.
    expect(cached.result!.snapshot!.credits!.balance).toBe("12.50");
  }
});

test("a failure's message reaches a non-owner only as the one line the popover compares it with", async () => {
  const unsupported = fullReading("unsupported");
  const read = await access(workspaceAdmin, { cached: unsupported }).usage.read(principal, scope);
  expect(read.result).toMatchObject({
    status: "unsupported",
    message: "Usage reader is not connected yet",
  });
  expect(read.result).not.toHaveProperty("lastAttemptAt");

  unsupported.result!.message = "codex: /home/owner/.codex/config.toml is unreadable";
  const other = await access(workspaceAdmin, { cached: unsupported }).usage.read(principal, scope);
  expect(other.result).not.toHaveProperty("message");
  expect(
    (await access(computerOwner, { cached: unsupported }).usage.read(principal, scope)).result
      ?.message,
  ).toContain("config.toml");
});

test("another member's default cloud Computer is as hidden from usage as from the Computer list", async () => {
  const defaultCloud = { kind: "cloud", cloudSlot: "default" };
  for (const connection of [workspaceAdmin, workspaceOwner]) {
    const { usage, calls } = access(connection, { computer: defaultCloud });
    await expect(usage.read(principal, scope)).rejects.toThrow("runtime is not available");
    await expect(usage.scan(principal, scope)).rejects.toThrow("runtime is not available");
    expect(calls).toEqual([]);
  }
  // Its owner, and every other kind of Computer, are not hidden.
  const owner = access(computerOwner, { computer: defaultCloud });
  expect(await owner.usage.read(principal, scope)).toBe(reading);
  for (const computer of [
    { kind: "cloud", cloudSlot: "extra" },
    { kind: "local", cloudSlot: null },
  ]) {
    expect(await access(workspaceAdmin, { computer }).usage.read(principal, scope)).toBe(reading);
  }
});

test("a reading with no snapshot, or no credits, reads through unchanged for a non-owner", async () => {
  const bare = {
    state: "stale",
    result: { ...scope, scanId: "s", status: "reauth", collectedAt: "2026-09-17T00:00:00Z" },
  } as const satisfies UsageReadResult;
  expect(await access(workspaceAdmin, { cached: bare }).usage.read(principal, scope)).toEqual(bare);
  const noCredits = fullReading();
  delete noCredits.result!.snapshot!.credits;
  const read = await access(workspaceAdmin, { cached: noCredits }).usage.read(principal, scope);
  expect(read.result?.snapshot).not.toHaveProperty("credits");
});

test("a scan hands back only its id and no reading, whoever asks", async () => {
  for (const connection of [computerOwner, workspaceAdmin]) {
    const result = await access(connection, { cached: fullReading() }).usage.scan(principal, scope);
    expect(result).toEqual({ scanId: "scan-1", status: "pending" });
  }
});

/** The runtime row the profile is handed, `undefined` for who may not read its usage. */
async function runtimeOf(usage: ReturnType<typeof access>["usage"]) {
  return (await usage.usageOffer(principal, scope)).runtime;
}

test("the runtime row is handed only to who may read its usage, and never thrown for", async () => {
  for (const connection of [computerOwner, workspaceAdmin, workspaceOwner]) {
    expect(await runtimeOf(access(connection).usage)).toMatchObject({
      ownerId: connection.ownerId,
    });
  }
  const { usage, calls } = access(plainMember);
  expect(await runtimeOf(usage)).toBeUndefined();
  for (const connection of [undefined, { ownerId: "x", role: "weird" }]) {
    expect(await runtimeOf(access(connection).usage)).toBeUndefined();
  }
  expect(
    await runtimeOf(access(workspaceAdmin, { runtimeInstalled: false }).usage),
  ).toBeUndefined();
  // Asking reads neither the cache nor starts a scan.
  expect(calls).toEqual([]);
});

test("another member's default cloud Computer hands an admin no runtime row, its owner and other Computers do", async () => {
  const defaultCloud = { kind: "cloud", cloudSlot: "default" };
  for (const connection of [workspaceAdmin, workspaceOwner]) {
    expect(await runtimeOf(access(connection, { computer: defaultCloud }).usage)).toBeUndefined();
  }
  expect(await runtimeOf(access(computerOwner, { computer: defaultCloud }).usage)).toBeDefined();
  expect(
    await runtimeOf(
      access(workspaceAdmin, { computer: { kind: "cloud", cloudSlot: "extra" } }).usage,
    ),
  ).toBeDefined();
});

test("another member's private runtime is as hidden from usage as from the Computer page; its owner still reads it", async () => {
  for (const connection of [workspaceAdmin, workspaceOwner]) {
    const { usage, calls } = access(connection, { isPublic: false });
    await expect(usage.read(principal, scope)).rejects.toThrow("runtime is not available");
    await expect(usage.scan(principal, scope)).rejects.toThrow("runtime is not available");
    expect(await runtimeOf(usage)).toBeUndefined();
    expect(calls).toEqual([]);
  }
  const owner = access(computerOwner, { isPublic: false });
  expect(await owner.usage.read(principal, scope)).toBe(reading);
  expect(await runtimeOf(owner.usage)).toBeDefined();
});

test("the profile offers usage as the Computer page does: not for a runtime that cannot start", async () => {
  for (const connection of [computerOwner, workspaceAdmin]) {
    const usable = await access(connection).usage.usageOffer(principal, scope);
    expect(usable.offered).toBe(true);
    const unusable = await access(connection, {
      unavailableCode: "start_failed",
    }).usage.usageOffer(principal, scope);
    // The version stays for the popover's header; the usage itself is withheld.
    expect(unusable.offered).toBe(false);
    expect(unusable.runtime).toBeDefined();
  }
  const refused = await access(plainMember).usage.usageOffer(principal, scope);
  expect(refused).toEqual({ runtime: undefined, offered: false });
});
