import { expect, test } from "bun:test";

import {
  computerRestartBusy,
  runComputerRestart,
} from "#src/features/computers/computer-restart-run";
import type { ComputerRestartStatus } from "#src/features/computers/computer.schemas";
import { AppError } from "#src/lib/app-error";

const status = (value: ComputerRestartStatus["status"]) =>
  ({ requestId: "r1", status: value }) as ComputerRestartStatus;

function recorder() {
  const heard: string[] = [];
  return {
    heard,
    report: {
      accepted: () => heard.push("accepted"),
      completed: () => heard.push("completed"),
      failed: (reason: string) => heard.push(`failed:${reason}`),
    },
  };
}

test("the result is reported once the Computer has restarted, whoever is still watching", async () => {
  const { heard, report } = recorder();
  const reads = [status("accepted"), status("completed")];
  await runComputerRestart(
    {
      requestId: "r1",
      restart: async () => status("accepted"),
      readStatus: async () => reads.shift()!,
      pollIntervalMs: 0,
      maxPolls: 5,
    },
    report,
  );
  expect(heard).toEqual(["accepted", "completed"]);
});

test("a restart still running after the last poll is reported as past its deadline", async () => {
  const { heard, report } = recorder();
  await runComputerRestart(
    {
      requestId: "r1",
      restart: async () => status("accepted"),
      readStatus: async () => status("accepted"),
      pollIntervalMs: 0,
      maxPolls: 2,
    },
    report,
  );
  expect(heard).toEqual(["accepted", "failed:deadline"]);
});

test("an offline Computer is named as the reason", async () => {
  const { heard, report } = recorder();
  await runComputerRestart(
    {
      requestId: "r1",
      restart: async () => {
        throw new AppError("COMPUTER_OFFLINE");
      },
      pollIntervalMs: 0,
      maxPolls: 2,
    },
    report,
  );
  expect(heard).toEqual(["failed:offline"]);
});

test("Restart waits only on work already under way, not on the Computer being offline", () => {
  expect(computerRestartBusy({ upgrading: true, restartState: "idle" })).toBe(true);
  expect(computerRestartBusy({ upgrading: false, restartState: "pending" })).toBe(true);
  expect(computerRestartBusy({ upgrading: false, restartState: "accepted" })).toBe(true);
  for (const restartState of ["idle", "completed", "error"] as const)
    expect(computerRestartBusy({ upgrading: false, restartState })).toBe(false);
});
