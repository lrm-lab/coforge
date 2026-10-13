import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCoforgeSessionDir, prepareAgentSessionDirectory } from "#src/paths";
import { resolveAgentSessionFile } from "#src/runner";

type SessionMessage = ReturnType<SessionManager["buildSessionContext"]>["messages"][number];

/** One step of a single agent's runtime session, kept for training. */
export type AgentTrainingStep =
  | {
      kind: "user" | "assistant";
      text: string;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: string;
      isError: boolean;
    };

export type AgentTrainingTrajectory = {
  sessionId: string;
  steps: AgentTrainingStep[];
};

/**
 * Read one agent's unfiltered runtime session for training.
 * Recall tools stay in this copy. The channel memory session is a separate write.
 */
export async function exportAgentTrainingTrajectory(input: {
  cwd: string;
  sessionId: string;
}): Promise<AgentTrainingTrajectory> {
  const sessionDir = getCoforgeSessionDir(input.cwd);
  const file = await resolveAgentSessionFile(input.cwd, sessionDir, input.sessionId);
  const workspace = await prepareAgentSessionDirectory(input.cwd, sessionDir);
  const session = SessionManager.open(file, sessionDir, workspace);
  return {
    sessionId: session.getSessionId(),
    steps: stepsFromMessages(session.buildSessionContext().messages),
  };
}

function stepsFromMessages(messages: readonly SessionMessage[]): AgentTrainingStep[] {
  const steps: AgentTrainingStep[] = [];
  const tools = new Map<string, Extract<AgentTrainingStep, { kind: "tool" }>>();

  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text.length > 0) steps.push({ kind: "user", text });
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      const flushText = () => {
        if (text.length === 0) return;
        steps.push({ kind: "assistant", text });
        text = "";
      };
      for (const part of message.content) {
        if (part.type === "text") {
          text += part.text;
          continue;
        }
        if (part.type !== "toolCall") continue;
        flushText();
        const step: Extract<AgentTrainingStep, { kind: "tool" }> = {
          kind: "tool",
          toolCallId: part.id,
          toolName: part.name,
          input: part.arguments,
          output: "",
          isError: false,
        };
        steps.push(step);
        tools.set(part.id, step);
      }
      flushText();
      continue;
    }
    if (message.role === "toolResult") {
      const output = textOf(message.content);
      const existing = tools.get(message.toolCallId);
      if (existing) {
        existing.output = output;
        existing.isError = message.isError;
        continue;
      }
      steps.push({
        kind: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        input: {},
        output,
        isError: message.isError,
      });
      continue;
    }
    if (message.role === "bashExecution") {
      steps.push({
        kind: "tool",
        toolCallId: `bash:${message.timestamp}`,
        toolName: "bash",
        input: { command: message.command },
        output: message.output,
        isError: typeof message.exitCode === "number" && message.exitCode !== 0,
      });
    }
  }

  return steps;
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}
