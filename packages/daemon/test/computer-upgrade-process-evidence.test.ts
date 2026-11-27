import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordComputerUpgradeProcesses,
  computerUpgradeProcessesExited,
} from "#src/platform/computer-upgrade-process-evidence";
import { sweepComputerUpgradeReceipts } from "#src/platform/computer-upgrade-receipts";
import { installerJournalPath } from "#src/platform/installer-journal";

const requestId = "0194f1c2-aaaa-7bbb-8ccc-ddddeeeeffff";
const boot = "0194f1c2-abcd-7bbb-8ccc-ddddeeeeff00";
const wrapper = 128;
const installer = 129;
const operation = { requestId, requestedAt: 100 };

function procStat(pid: number, startTicks: number, ppid = 1, state = "S") {
  return `${pid} (fixture) ${[state, ppid, 2, ...Array(16).fill(0), startTicks].join(" ")}`;
}

async function evidenceFixture(
  body: (input: {
    installRoot: string;
    proc: Map<string, string>;
    options: { readProc: (path: string) => Promise<string>; now: () => number };
  }) => Promise<void>,
) {
  const installRoot = await mkdtemp(join(tmpdir(), "coforge-upgrade-process-"));
  const proc = new Map([
    ["/proc/sys/kernel/random/boot_id", boot],
    [`/proc/${wrapper}/stat`, procStat(wrapper, 411)],
    [`/proc/${installer}/stat`, procStat(installer, 412, wrapper)],
  ]);
  const options = {
    now: () => 200,
    readProc: async (path: string) => {
      if (!proc.has(path)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return proc.get(path)!;
    },
  };
  try {
    await recordComputerUpgradeProcesses(installRoot, requestId, wrapper, installer, options);
    await body({ installRoot, proc, options });
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
}

test("waits for both receipt writers to exit and fences PID reuse by start ticks", async () => {
  await evidenceFixture(async ({ installRoot, proc, options }) => {
    expect(await computerUpgradeProcessesExited(installRoot, operation, options)).toBe(false);
    proc.delete(`/proc/${installer}/stat`);
    expect(await computerUpgradeProcessesExited(installRoot, operation, options)).toBe(false);
    proc.set(`/proc/${wrapper}/stat`, procStat(wrapper, 850));
    expect(await computerUpgradeProcessesExited(installRoot, operation, options)).toBe(true);
  });
});

test("a recovery journal or an unrecognized operation keeps the pending TTL fallback", async () => {
  await evidenceFixture(async ({ installRoot, proc, options }) => {
    proc.delete(`/proc/${wrapper}/stat`);
    proc.delete(`/proc/${installer}/stat`);
    expect(
      await computerUpgradeProcessesExited(
        installRoot,
        { ...operation, requestedAt: 201 },
        options,
      ),
    ).toBe(false);
    await Bun.write(installerJournalPath(installRoot), "{}");
    expect(await computerUpgradeProcessesExited(installRoot, operation, options)).toBe(false);
  });
});

test("an unreadable proc entry is unknown and never treated as an exited process", async () => {
  await evidenceFixture(async ({ installRoot, proc, options }) => {
    proc.delete(`/proc/${wrapper}/stat`);
    expect(
      await computerUpgradeProcessesExited(installRoot, operation, {
        readProc: (path) =>
          path === `/proc/${installer}/stat`
            ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
            : options.readProc(path),
      }),
    ).toBe(false);
  });
});

test("a proven job exit settles promptly, while a receipt appearing during the check wins", async () => {
  const operation = {
    requestId: "0194f1c2-aaaa-7bbb-8ccc-ddddeeeeffff",
    workspaceId: "ws",
    requestedAt: 0,
  };
  for (const lateReceipt of [false, true]) {
    const completed: string[] = [];
    let readCount = 0;
    const settled = await sweepComputerUpgradeReceipts(
      [operation],
      async (_workspaceId, _requestId, receipt) => {
        completed.push(receipt.status);
        if (!lateReceipt) expect(receipt.error).toBe("upgrade processes exited without a receipt");
      },
      {
        now: () => 50,
        pendingTtlMs: 100,
        processesExited: async () => true,
        readReceipt: async () =>
          ++readCount > 1 && lateReceipt
            ? { requestId: operation.requestId, status: "succeeded", at: 51 }
            : undefined,
      },
    );
    expect(settled).toBe(1);
    expect(completed).toEqual([lateReceipt ? "succeeded" : "failed"]);
  }
});
