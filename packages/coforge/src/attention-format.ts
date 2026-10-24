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
