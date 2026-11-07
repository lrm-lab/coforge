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
  /** True only for a genuine requestId replay of the same outcome: already accepted earlier,
   * not a rejection. */
  replayed?: boolean;
  /** The slot's status after this call (accepted outcome or the settled one). */
  slotStatus?: string;
  /** This accept moved the run into synthesis — a ready pack closed the wave. */
  synthesisStarted?: boolean;
  /** Every slot is terminal with no ready pack — the run is closed with nothing to build. */
  waveExhausted?: boolean;
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
  // the message must say what happened to the slot and what the run does next, in words an
  // Agent can act on: never "cancelled", never internal field names (#695).
  const slot = result.slotStatus ?? collect.outcome;
  if (result.newlyAccepted === false) {
    const settled = result.slotStatus ? ` as ${result.slotStatus}` : "";
    return result.replayed
      ? `Collect submit already accepted earlier; the slot is ${slot}.`
      : `Collect submit not accepted: the slot already settled${settled}.`;
  }
  const next = result.synthesisStarted
    ? "The weekly report is now being written."
    : result.waveExhausted
      ? "This collect run is closed: no usable pack was collected. Nothing else to do."
      : result.allTerminal === false
        ? "Other collectors are still working."
        : "";
  return `Collect ${slot} accepted.${next ? ` ${next}` : ""}`;
}
