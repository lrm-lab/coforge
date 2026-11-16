export function targetConfirmationRequiredMessage(target: string, threadTarget: string): string {
  return [
    `Possible thread target mismatch: your latest read context under ${target} is ${threadTarget}, but this send targets ${target} top-level.`,
    "This guard is intentionally narrow: moving a thread conclusion to the parent channel can be correct, but it is uncommon enough to confirm once.",
    "",
    "If this reply belongs in the thread, send the message to the thread target instead:",
    `  coforge message send --target "${threadTarget}" <<'COFORGE_MESSAGE'`,
    "  message body",
    "  COFORGE_MESSAGE",
    "",
    "If the top-level channel message is intentional, send the saved draft unchanged:",
    `  coforge message send --send-draft --target "${target}"`,
    "",
    `No message was sent. Send to ${threadTarget} if this belongs in the thread, or confirm the saved top-level draft with \`coforge message send --send-draft --target "${target}"\`.`,
  ].join("\n");
}
