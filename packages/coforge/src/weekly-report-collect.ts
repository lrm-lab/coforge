export type WeeklyReportCollectCommand = {
  idempotencyKey: string;
  runId: string;
  outcome: "ready" | "empty" | "failed";
  packMarkdown?: string;
  failureReason?: string;
};
export type WeeklyReportCollectResult = {
  idempotencyKey: string;
  runId: string;
  /** The Collect Run's status — not the slot's fate; a wave-exhausting accept cancels it. */
  status: string;
  allTerminal: boolean;
  canSynthesize: boolean;
  /** False when the slot was already settled or this is a requestId replay. */
  newlyAccepted?: boolean;
  /** The slot's status after this call (accepted outcome or the settled one). */
  slotStatus?: string;
};
export type WeeklyReportCollectInvocation = {
  command: "weekly-report-collect";
  collect: WeeklyReportCollectCommand;
  /** When set, `run` loads this file into `collect.packMarkdown` before posting. */
  markdownPath?: string;
};

/** `coforge weekly-report-collect submit-*`: load the pack file, post, format the answer. */
export async function runWeeklyReportCollect(
  invocation: WeeklyReportCollectInvocation,
  transport: {
    weeklyReportCollect?(command: WeeklyReportCollectCommand): Promise<WeeklyReportCollectResult>;
  },
): Promise<string> {
  if (!transport.weeklyReportCollect)
    throw new Error("Weekly report collect transport is unavailable");
  let collect = invocation.collect;
  if (invocation.markdownPath) {
    const packMarkdown = await Bun.file(invocation.markdownPath).text();
    collect = { ...collect, packMarkdown };
  }
  const result = await transport.weeklyReportCollect(collect);
  // `status` is the run's, which a wave-exhausting accept sets to cancelled in the same call —
  // report the slot's own fate so an accepted empty never reads as a cancelled slot (#695).
  if (result.newlyAccepted === false)
    return `Collect submit not accepted: slot already settled${result.slotStatus ? ` as ${result.slotStatus}` : ""} (run ${result.runId} status: ${result.status}).`;
  return `Collect ${result.slotStatus ?? collect.outcome} accepted (run ${result.runId} status: ${result.status}; allTerminal=${result.allTerminal}; canSynthesize=${result.canSynthesize}).`;
}
