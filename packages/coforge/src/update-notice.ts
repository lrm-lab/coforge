/** The deduped "a newer Computer release exists" line an Agent CLI appends after its output.
 * The daemon owns freshness and once-a-day dedup (`computer-update-notice`); this side only
 * decides whether a line may follow the command's output: never after `--json`, never when the
 * daemon is unreachable, and never when there is nothing newer to say. */
export async function updateNoticeLine(
  transport: { computerUpdateNotice?: () => Promise<{ ok: true; notice: string | null }> },
  args: readonly string[],
): Promise<string | undefined> {
  if (args.includes("--json")) return undefined;
  try {
    const { notice } = (await transport.computerUpdateNotice?.()) ?? { notice: null };
    return notice ?? undefined;
  } catch {
    return undefined;
  }
}
