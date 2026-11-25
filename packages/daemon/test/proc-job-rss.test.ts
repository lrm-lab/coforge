import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireProcJobGroupBootId,
  spawnDetachedProcJob,
  stopVerifiedProcJob,
} from "#src/platform/proc-job-process";
import {
  parseProcJobPsRss,
  readProcJobRssGroups,
  type ProcJobRssGroup,
} from "#src/platform/proc-job-rss";
import {
  ProcJobRssSampler,
  PROC_JOB_RSS_INTERVAL_MS,
  type ProcJobRssTarget,
} from "#src/proc-jobs/proc-job-rss-sampler";

const mib = 1024 * 1024;
const target: ProcJobRssTarget = {
  id: "test-job",
  pid: 44,
  pgid: 44,
  groupAnchor: true,
  startIdentity: "first-start",
  limitBytes: 32 * mib,
};

function samplerFixture(timeoutMs?: number) {
  let clock = 0;
  let rss: ProcJobRssGroup | undefined = { bytes: 34 * mib, members: new Set([44, 45]) };
  let verified = true;
  let reads = 0;
  let deferred: Promise<ReadonlyMap<number, ProcJobRssGroup> | undefined> | undefined;
  const sampler = new ProcJobRssSampler({
    now: () => clock,
    timeoutMs,
    verifyAnchor: async () => verified,
    readGroups: async () => {
      reads++;
      if (deferred) return deferred;
      return rss ? new Map([[44, rss]]) : undefined;
    },
  });
  return {
    sampler,
    tick: (intervals = 1) => {
      clock += PROC_JOB_RSS_INTERVAL_MS * intervals;
    },
    set: (bytes: number | undefined) => {
      rss = bytes === undefined ? undefined : { bytes, members: new Set([44, 45]) };
    },
    verify: (enabled: boolean) => {
      verified = enabled;
    },
    delay: (read: typeof deferred) => {
      deferred = read;
    },
    reads: () => reads,
  };
}

test("RSS is summed in bytes for live processes by group", () => {
  const snapshot = parseProcJobPsRss(" 44 44 S 4096\n45 44 R+ 1024\n46 44 Z 100\n47 47 Ss 42\n");
  expect(snapshot?.get(44)).toEqual({ bytes: 5120 * 1024, members: new Set([44, 45]) });
  expect(snapshot?.get(47)?.bytes).toBe(42 * 1024);
  expect(parseProcJobPsRss("44 44 S 1024\n45 44 R bad\n")).toBeUndefined();
  expect(parseProcJobPsRss("44 44 S 1024\n44 44 R 1024\n")).toBeUndefined();
  expect(parseProcJobPsRss("44 44 S 9007199254740992\n")).toBeUndefined();
});

test("Mac and Linux report RSS for the current verified process group", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const groups = await readProcJobRssGroups(process.platform, AbortSignal.timeout(5_000));
  const current = [...(groups?.values() ?? [])].find((entry) => entry.members.has(process.pid));
  expect(current?.bytes).toBeGreaterThan(mib);
}, 6_000);

test("two adjacent strictly over-limit observations are required", async () => {
  const f = samplerFixture();
  expect(PROC_JOB_RSS_INTERVAL_MS).toBe(15_000);
  expect(await f.sampler.sample([target])).toEqual([
    { id: target.id, bytes: 34 * mib, overLimit: false },
  ]);
  f.tick();
  f.set(32 * mib);
  expect((await f.sampler.sample([target]))?.[0]).toMatchObject({
    bytes: 32 * mib,
    overLimit: false,
  });
  f.tick();
  f.set(34 * mib);
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick();
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(true);
});

test("loss of ownership, missing samples, a skipped tick, and a new identity reset the streak", async () => {
  const f = samplerFixture();
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick();
  f.verify(false);
  expect((await f.sampler.sample([target]))?.[0]).toEqual({
    id: target.id,
    bytes: undefined,
    overLimit: false,
  });
  f.tick();
  f.verify(true);
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick();
  f.set(undefined);
  expect((await f.sampler.sample([target]))?.[0]?.bytes).toBeUndefined();
  f.tick();
  f.set(34 * mib);
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick(2);
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick();
  expect(
    (await f.sampler.sample([{ ...target, startIdentity: "new-start" }]))?.[0]?.overLimit,
  ).toBe(false);
  f.tick();
  expect(
    (
      await new ProcJobRssSampler({
        now: () => 0,
        readGroups: async () => new Map([[44, { bytes: 34 * mib, members: new Set([44]) }]]),
        verifyAnchor: async () => true,
      }).sample([target])
    )?.[0]?.overLimit,
  ).toBe(false);
});

test("overlapping samples do not advance the streak and ownership is checked again after the scan", async () => {
  const f = samplerFixture();
  const pending = Promise.withResolvers<ReadonlyMap<number, ProcJobRssGroup> | undefined>();
  f.delay(pending.promise);
  const first = f.sampler.sample([target]);
  expect(await f.sampler.sample([target])).toBeUndefined();
  f.verify(false);
  pending.resolve(new Map([[44, { bytes: 34 * mib, members: new Set([44]) }]]));
  expect((await first)?.[0]?.bytes).toBeUndefined();
  expect(f.reads()).toBe(1);
  f.delay(undefined);
  f.tick();
  f.verify(true);
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
});

test("a timed-out read resets the streak, even when the read resolves late", async () => {
  const f = samplerFixture(40);
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick();
  const pending = Promise.withResolvers<ReadonlyMap<number, ProcJobRssGroup> | undefined>();
  f.delay(pending.promise);
  expect((await f.sampler.sample([target]))?.[0]).toEqual({
    id: target.id,
    bytes: undefined,
    overLimit: false,
  });
  pending.resolve(new Map([[44, { bytes: 34 * mib, members: new Set([44]) }]]));
  f.delay(undefined);
  f.tick();
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(false);
  f.tick();
  expect((await f.sampler.sample([target]))?.[0]?.overLimit).toBe(true);
}, 2_000);

test("a real anchored group is measured and an unrelated identity is ignored", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const groupAnchorBootId = await requireProcJobGroupBootId(process.platform);
  const cwd = await mkdtemp(join(tmpdir(), "coforge-proc-rss-"));
  const ended = Promise.withResolvers<void>();
  let owned: ProcJobRssTarget | undefined;
  try {
    const spawned = await spawnDetachedProcJob({
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      logPath: join(cwd, "job.log"),
      command: [process.execPath, "-e", "await Bun.sleep(10000)"],
      groupAnchor: true,
      onExit: () => ended.resolve(),
    });
    owned = {
      id: "owned",
      pid: spawned.pid,
      pgid: spawned.pid,
      groupAnchor: true,
      groupAnchorBootId,
      startIdentity: spawned.startIdentity!,
      limitBytes: mib,
    };
    const differentIdentity = { ...owned, id: "foreign", startIdentity: "stale" };
    let now = 0;
    const sampler = new ProcJobRssSampler({ now: () => now });
    const first = await sampler.sample([owned, differentIdentity]);
    expect(first?.[0]?.bytes).toBeGreaterThan(mib);
    expect(first?.[0]?.overLimit).toBe(false);
    expect(first?.[1]).toEqual({ id: "foreign", bytes: undefined, overLimit: false });
    now += PROC_JOB_RSS_INTERVAL_MS;
    expect((await sampler.sample([owned]))?.[0]?.overLimit).toBe(true);
  } finally {
    try {
      if (owned && (await stopVerifiedProcJob(owned, { force: true })) === "stopped")
        await ended.promise;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}, 12_000);
