import { OPENVIKING_AGENT_PROTOCOL, OPENVIKING_TOOL_NAMES } from "@lrm/coforge-sdk/agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Settle idle channel polling normally; queued and later inputs stay resumable. */
export function installChannelTurnPolicy(
  session: AgentSession,
  options: { settleMessageSends?: boolean } = {},
) {
  let emptyChecks = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "user") emptyChecks = 0;
  });
  const previous = session.agent.finishTurn;
  const finishTurn: NonNullable<typeof previous> = async (turn, signal) => {
    const decision = await previous?.(turn, signal);
    if (decision?.action === "end") return decision;
    const published = turn.toolResults.some((result) => {
      if (
        result.isError ||
        (result.toolName !== OPENVIKING_TOOL_NAMES.offer &&
          result.toolName !== OPENVIKING_TOOL_NAMES.diagnose)
      )
        return false;
      return result.content.some((item) => {
        if (item.type !== "text") return false;
        try {
          const receipt = JSON.parse(item.text);
          return (
            receipt?.protocol === OPENVIKING_AGENT_PROTOCOL &&
            ((result.toolName === OPENVIKING_TOOL_NAMES.offer && receipt.op === "offer") ||
              (result.toolName === OPENVIKING_TOOL_NAMES.diagnose &&
                receipt.op === "diagnose" &&
                receipt.status === "completed")) &&
            receipt.published === true &&
            typeof receipt.messageId === "string" &&
            receipt.messageId.length > 0
          );
        } catch {
          return false;
        }
      });
    });
    if (published) return { action: "end" };
    const calls = new Map(
      turn.message.content
        .filter((item) => item.type === "toolCall")
        .map((item) => [item.id, item]),
    );
    if (
      options.settleMessageSends &&
      turn.toolResults.some((result) => {
        const command = calls.get(result.toolCallId)?.arguments.command;
        if (
          result.isError ||
          result.toolName !== "bash" ||
          typeof command !== "string" ||
          !/^\s*coforge\s+message\s+send\b/.test(command)
        )
          return false;
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
          .trim();
        try {
          const receipt = JSON.parse(text);
          return (
            (receipt?.accepted === true || receipt?.state === "sent") &&
            typeof receipt.messageId === "string" &&
            receipt.messageId.length > 0
          );
        } catch {
          return /^Message sent to #[^\r\n]+\. Message ID: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            text,
          );
        }
      })
    )
      return { action: "end" };
    const idle =
      turn.toolResults.length > 0 &&
      turn.toolResults.every((result) => {
        const command = calls.get(result.toolCallId)?.arguments.command;
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        return (
          !result.isError &&
          result.toolName === "bash" &&
          typeof command === "string" &&
          /^\s*coforge\s+message\s+(?:check|read)\b/.test(command) &&
          !/[;|&<>\n]/.test(command.trim()) &&
          text.trim() === "No new messages."
        );
      });
    emptyChecks = idle ? emptyChecks + turn.toolResults.length : 0;
    return emptyChecks >= 2 ? { action: "end" } : (decision ?? undefined);
  };
  session.agent.finishTurn = finishTurn;
  return () => {
    unsubscribe();
    if (session.agent.finishTurn === finishTurn) session.agent.finishTurn = previous;
  };
}
