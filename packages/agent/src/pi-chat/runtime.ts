import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { join } from "node:path";
import { rename, rm } from "node:fs/promises";
import type { PiChatMessage, PiChatUpdate } from "@lrm/coforge-sdk/internal/pi-chat";
import { createSession } from "#src/runner";
import { PI_SESSION_DIR } from "#src/paths";
import type { PiChatRuntime } from "./sessions";
import { recoverPiChatTurn } from "./recovery";

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
  details: z.unknown().optional(),
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
    details: message.details === undefined ? undefined : JSON.stringify(message.details, null, 2),
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
  onUpdate?: (update: PiChatUpdate) => void,
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
  // Pi lazily creates JSONL on the first message. Persist the empty native
  // session before accepting a request so a preflight failure can still resume.
  const manager = runtime.session.sessionManager;
  const file = manager.getSessionFile();
  const temporary = file ? `${file}.${crypto.randomUUID()}.tmp` : undefined;
  try {
    if (!id && file && temporary && !(await Bun.file(file).exists())) {
      runtime.session.exportToJsonl(temporary);
      await rename(temporary, file);
      manager.setSessionFile(file);
    }
  } catch (error) {
    await runtime.dispose();
    throw error;
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
  let pending: PiChatMessage | undefined;
  let failed = false;
  const tools = new Map<string, PiChatMessage>();
  const emit = (update: Omit<PiChatUpdate, "sessionId">) => {
    try {
      onUpdate?.({ sessionId: runtime.sessionId, ...update });
    } catch {
      /* Observation cannot fail a native turn. */
    }
  };
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_update") {
      pending = chatMessage("streaming", event.message);
      if (pending) emit({ messages: [pending] });
    }
    if (event.type === "message_end") {
      if (event.message.role === "assistant") failed = event.message.stopReason === "error";
      pending = undefined;
      if (event.message.role === "toolResult") tools.delete(event.message.toolCallId);
      // Pi notifies listeners before appending the native entry. Read after that synchronous append.
      queueMicrotask(() => {
        const message = storedChatMessages(runtime.session.sessionManager).at(-1);
        if (message)
          emit({
            messages: [message],
            removeIds:
              event.message.role === "toolResult"
                ? [`running:${event.message.toolCallId}`]
                : ["streaming"],
          });
      });
    }
    if (event.type === "tool_execution_end")
      runtime.session.sessionManager.appendCustomEntry("pi-chat-tool-outcome", {
        callId: event.toolCallId,
        durationMs: event.durationMs,
        parentToolCallId: event.parentToolCallId,
      });
    if (event.type === "tool_execution_start") {
      tools.set(event.toolCallId, {
        id: `running:${event.toolCallId}`,
        role: "tool",
        text: "",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
      emit({ messages: [tools.get(event.toolCallId)!] });
    }
    if (event.type === "tool_execution_update") {
      const partial = chatMessage(`running:${event.toolCallId}`, {
        ...event.partialResult,
        role: "toolResult",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
      if (partial) {
        tools.set(event.toolCallId, partial);
        emit({ messages: [partial] });
      }
    }
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
    resume: async (checkpoint) => {
      failed = false;
      await recoverPiChatTurn(runtime.session, checkpoint);
      if (failed) throw new Error("Pi model request failed");
    },
    abort: () => runtime.session.abort(),
    dispose: async () => {
      unsubscribe();
      await runtime.dispose();
    },
  };
}
