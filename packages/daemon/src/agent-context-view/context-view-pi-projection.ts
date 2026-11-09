import type { RecordValue, RestoredContextMessage } from "./context-view-restore";
import { isRecord, message, parseToolInput } from "./context-view-restore-primitives";

function piContentParts(content: unknown): unknown[] {
  const items =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [content];
  return items.flatMap((item) => {
    if (typeof item === "string") return [{ kind: "text", text: item }];
    if (!isRecord(item)) return [];
    if (item.type === "compaction")
      return [{ kind: "compaction", text: typeof item.text === "string" ? item.text : null }];
    if (typeof item.text === "string") return [{ kind: "text", text: item.text }];
    if (item.type === "media_removed") return [{ kind: "text", text: "[media removed]" }];
    if (item.type === "image" || item.type === "audio" || item.type === "media")
      return [
        {
          kind: "image",
          mediaType: typeof item.mediaType === "string" ? item.mediaType : null,
          sizeBytes: null,
        },
      ];
    if (item.type === "input_text" || item.type === "output_text")
      return [{ kind: "text", text: typeof item.text === "string" ? item.text : "" }];
    if (Array.isArray(item.tool_calls))
      return item.tool_calls.flatMap((call) =>
        isRecord(call)
          ? [
              {
                kind: "tool_use",
                toolName:
                  isRecord(call.function) && typeof call.function.name === "string"
                    ? call.function.name
                    : "unknown",
                toolUseId: typeof call.id === "string" ? call.id : null,
                input: isRecord(call.function) ? parseToolInput(call.function.arguments) : null,
              },
            ]
          : [],
      );
    if (item.type === "function_call" || item.type === "tool_call")
      return [
        {
          kind: "tool_use",
          toolName: typeof item.name === "string" ? item.name : "unknown",
          toolUseId:
            typeof item.call_id === "string"
              ? item.call_id
              : typeof item.id === "string"
                ? item.id
                : null,
          input: parseToolInput(item.arguments ?? item.input),
        },
      ];
    if (item.type === "function_call_output" || item.type === "tool_result")
      return [
        {
          kind: "tool_result",
          toolName: null,
          toolUseId:
            typeof item.call_id === "string"
              ? item.call_id
              : typeof item.id === "string"
                ? item.id
                : null,
          output:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output ?? item.content ?? ""),
          isError: false,
        },
      ];
    if (item.content !== undefined) return piContentParts(item.content);
    return [{ kind: "text", text: `[${typeof item.type === "string" ? item.type : "part"}]` }];
  });
}
export function piRequestMessages(
  body: RecordValue,
  api: string | undefined,
): RestoredContextMessage[] {
  const raw =
    api === "openai-completions"
      ? (body.messages ?? body.prompt)
      : api === "google-generative-ai" || api === "google-vertex"
        ? body.contents
        : (body.messages ?? body.input);
  if (!Array.isArray(raw)) return [message("user", raw)];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [message("user", entry)];
    const role =
      entry.role === "assistant" ||
      ((api === "google-generative-ai" || api === "google-vertex") && entry.role === "model")
        ? "assistant"
        : entry.role === "system" || entry.role === "developer"
          ? "system"
          : entry.role === "tool"
            ? "tool"
            : "user";
    return [{ role, parts: piContentParts(entry.content ?? entry.parts ?? entry.text ?? entry) }];
  });
}
export function piResponseParts(body: unknown): unknown {
  if (isRecord(body) && Array.isArray(body.output))
    return body.output.flatMap((item) =>
      isRecord(item) ? piContentParts(item.content ?? item.output ?? item) : [],
    );
  if (isRecord(body) && Array.isArray(body.contents))
    return body.contents.flatMap((content) =>
      isRecord(content) ? piContentParts(content.parts ?? content.content) : [],
    );
  if (isRecord(body) && Array.isArray(body.choices))
    return body.choices.flatMap((choice) =>
      isRecord(choice)
        ? piContentParts(
            isRecord(choice.message)
              ? choice.message.content
              : isRecord(choice.delta)
                ? (choice.delta.content ?? choice.delta)
                : choice.text,
          )
        : [],
    );
  return piContentParts(body);
}
