/**
 * The text of `channel mute|unmute`. CoForge's delivery rules decide what still arrives: a muted
 * channel's ordinary messages stop waking the Agent, while a personal @mention (which overrides
 * mute) and a thread the Agent started or follows still do. Raft prints a `Mute from seq` line
 * too; CoForge stores only whether a channel is muted, so it has no sequence to print.
 */
function formatChannelMute(target: string, muted: boolean): string {
  if (!muted)
    return [
      `Unmuted ${target}.`,
      "Activity muted: no",
      "Ordinary channel messages in this channel wake you again.",
      `To mute: coforge channel mute --target "${target}"`,
    ].join("\n");
  return [
    `Muted ${target}.`,
    "Activity muted: yes",
    "Ordinary channel messages in this channel no longer wake you; the history stays readable.",
    "Still arrives:",
    "- Personal @mentions still reach you.",
    "- Threads you started or follow stay followed.",
    `To unmute: coforge channel unmute --target "${target}"`,
  ].join("\n");
}

/** `channel mute|unmute`: changes the setting, then says what it now means. */
export async function setChannelMuted(
  update: ((target: string, muted: boolean) => Promise<unknown>) | undefined,
  { command, target }: { command: "mute" | "unmute"; target: string },
): Promise<string> {
  if (!update) throw new Error("Channel settings transport is unavailable");
  await update(target, command === "mute");
  return formatChannelMute(target, command === "mute");
}

/**
 * `thread unfollow`: stops ordinary delivery for a thread, then says what brings it back. The
 * reason is printed and not stored (CoForge keeps no reason for a follow), and a follow comes back
 * through a reply from the Agent or a reply that mentions it.
 */
export async function unfollowThread(
  unfollow: ((target: string, followed: boolean) => Promise<unknown>) | undefined,
  { target, reason }: { target: string; reason?: string },
): Promise<string> {
  if (!unfollow) throw new Error("Thread settings transport is unavailable");
  await unfollow(target, false);
  return [
    `Unfollowed ${target}. Ordinary delivery for this thread has stopped.`,
    `Reason: ${reason ?? "no longer following"}`,
    `A later reply that mentions you follows the thread again; unfollow it again with: coforge thread unfollow --target "${target}"`,
    "Replying in this thread follows it again automatically.",
  ].join("\n");
}
