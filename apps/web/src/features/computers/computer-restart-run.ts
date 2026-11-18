import { isAppErrorCode } from "#src/lib/app-error";

import type { ComputerRestartStatus } from "./computer.schemas";

export type ComputerRestartFailure = "deadline" | "offline" | "refused";

export type ComputerRestartState = "idle" | "pending" | "accepted" | "completed" | "error";

export function computerRestartBusy(input: {
  upgrading: boolean;
  restartState: ComputerRestartState;
}) {
  return input.upgrading || input.restartState === "pending" || input.restartState === "accepted";
}

export type ComputerRestartReport = {
  accepted: () => void;
  completed: () => void;
  failed: (reason: ComputerRestartFailure) => void;
};

export async function runComputerRestart(
  input: {
    requestId: string;
    restart: (requestId: string) => Promise<ComputerRestartStatus>;
    readStatus?: (requestId: string) => Promise<ComputerRestartStatus>;
    pollIntervalMs: number;
    maxPolls: number;
  },
  report: ComputerRestartReport,
): Promise<void> {
  let result: ComputerRestartStatus;
  try {
    result = await input.restart(input.requestId);
    if (result.status === "accepted") {
      report.accepted();
      if (!input.readStatus) return;
      for (let poll = 0; poll < input.maxPolls && result.status === "accepted"; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
        result = await input.readStatus(input.requestId);
      }
    }
  } catch (error) {
    report.failed(isAppErrorCode(error, "COMPUTER_OFFLINE") ? "offline" : "refused");
    return;
  }
  if (result.status === "completed") report.completed();
  else report.failed("deadline");
}
