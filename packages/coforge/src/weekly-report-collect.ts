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
  status: string;
  allTerminal: boolean;
  canSynthesize: boolean;
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
  return `Collect slot ${result.status} (run ${result.runId}; allTerminal=${result.allTerminal}; canSynthesize=${result.canSynthesize}).`;
}
