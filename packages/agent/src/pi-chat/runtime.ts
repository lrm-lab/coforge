import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { join } from "node:path";
import type { PiChatMessage } from "@lrm/coforge-sdk/internal/pi-chat";
import { createSession } from "#src/runner";
import { PI_SESSION_DIR } from "#src/paths";
import type { PiChatRuntime } from "./sessions";

const nativeMessage = z.object({
  role: z.string(),
  content: z.union([
    z.string(),
    z.array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
          thinking: z.string().optional(),
          id: z.string().optional(),
          name: z.string().optional(),
          arguments: z.unknown().optional(),
        })
        .passthrough(),
    ),
  ]),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
});

export function chatMessage(id: string, value: unknown): PiChatMessage | undefined {
  const parsed = nativeMessage.safeParse(value);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  if (!["user", "assistant", "toolResult"].includes(message.role)) return undefined;
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const toolCalls = content
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      id: part.id ?? "",
      name: part.name ?? "",
      input: JSON.stringify(part.arguments, null, 2) ?? "null",
    }));
  return {
    id,
    role: message.role === "toolResult" ? "tool" : message.role === "user" ? "user" : "assistant",
    text: content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
    thinking:
      content
        .filter((part) => part.type === "thinking")
        .map((part) => part.thinking ?? "")
        .join("\n") || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
  };
}

export function storedChatMessages(manager: SessionManager): PiChatMessage[] {
  const entries = manager.getEntries();
  const outcomeSchema = z.object({
    callId: z.string(),
    durationMs: z.number().nonnegative().optional(),
    parentToolCallId: z.string().optional(),
  });
  const outcomes = new Map(
    entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== "pi-chat-tool-outcome") return [];
      const parsed = outcomeSchema.safeParse(entry.data);
      return parsed.success ? [[parsed.data.callId, parsed.data] as const] : [];
    }),
  );
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = chatMessage(entry.id, entry.message);
    const outcome = message?.toolCallId ? outcomes.get(message.toolCallId) : undefined;
    if (message && outcome) {
      message.durationMs = outcome.durationMs;
      message.parentToolCallId = outcome.parentToolCallId;
    }
    return message ? [message] : [];
  });
}

export async function createPiChatRuntime(
  cwd: string,
  id?: string,
  agentDir = getAgentDir(),
): Promise<PiChatRuntime> {
  const runtime = await createSession({
    cwd,
    agentDir,
    sessionKind: "pi",
    sessionDir: join(cwd, PI_SESSION_DIR),
    sessionId: id,
    sessionMode: id ? "resume" : "create",
    instructions:
      "You are a helpful coding assistant working in the user's cloud computer. Answer in the user's language. Use tools when useful and explain the result clearly.",
  });
  if (id && runtime.sessionId !== id) {
    await runtime.dispose();
    throw new Error("saved session is unavailable");
  }
  let pending: PiChatMessage | undefined;
  let failed = false;
  const tools = new Map<string, PiChatMessage>();
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_update") pending = chatMessage("streaming", event.message);
    if (event.type === "message_end") {
      if (event.message.role === "assistant") failed = event.message.stopReason === "error";
      pending = undefined;
      if (event.message.role === "toolResult") tools.delete(event.message.toolCallId);
    }
    if (event.type === "tool_execution_end")
      runtime.session.sessionManager.appendCustomEntry("pi-chat-tool-outcome", {
        callId: event.toolCallId,
        durationMs: event.durationMs,
        parentToolCallId: event.parentToolCallId,
      });
    if (event.type === "tool_execution_start")
      tools.set(event.toolCallId, {
        id: `running:${event.toolCallId}`,
        role: "tool",
        text: "",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
    if (event.type === "tool_execution_update")
      tools.set(event.toolCallId, {
        id: `running:${event.toolCallId}`,
        role: "tool",
        text:
          chatMessage("partial", { role: "toolResult", content: event.partialResult.content })
            ?.text ?? "",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
  });
  return {
    id: runtime.sessionId,
    model: () =>
      runtime.session.model ? `${runtime.session.model.provider}/${runtime.session.model.id}` : "",
    messages: () => [
      ...storedChatMessages(runtime.session.sessionManager),
      ...(pending ? [pending] : []),
      ...tools.values(),
    ],
    prompt: async (text) => {
      failed = false;
      await runtime.session.prompt(text);
      if (failed) throw new Error("Pi model request failed");
    },
    abort: () => runtime.session.abort(),
    dispose: async () => {
      unsubscribe();
      await runtime.dispose();
    },
  };
}
