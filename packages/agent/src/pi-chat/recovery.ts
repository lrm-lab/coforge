import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiChatRecoveryUncertain, type PiChatCheckpoint } from "./checkpoint";

/** Continue from committed native results, never by replaying an accepted user turn. */
export async function recoverPiChatTurn(session: AgentSession, checkpoint: PiChatCheckpoint) {
  const messages = session.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role)
        ? [entry.message]
        : [],
    );
  if (checkpoint.messageCount > messages.length) throw new PiChatRecoveryUncertain();
  const pending = messages.slice(checkpoint.messageCount);
  const last = pending.at(-1);
  // A final answer also settles tool failures the assistant already handled.
  if (last?.role === "assistant" && last.stopReason === "stop") return;
  const tools = new Set<string>();
  for (const message of pending) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") tools.add(part.id);
    } else if (message.role === "toolResult") {
      if (message.isError) throw new PiChatRecoveryUncertain();
      tools.delete(message.toolCallId);
    }
  }
  if (tools.size) throw new PiChatRecoveryUncertain();
  if (!pending.length) {
    await session.prompt(checkpoint.message);
    return;
  }
  await session.sendCustomMessage(
    {
      customType: "pi-chat-recovery",
      display: false,
      content:
        "The cloud computer connection was restored after an interrupted turn. Continue the user's unfinished request using this saved session and its tool results. Do not repeat completed tool calls or repeat the user's request. If an operation's outcome cannot be determined, inspect its current state before acting; ask the user when it cannot be established safely. If the request is already complete, finish without additional actions.",
    },
    { triggerTurn: true },
  );
}
