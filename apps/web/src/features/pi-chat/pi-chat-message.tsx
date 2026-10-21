import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { PiChatMessage as Message } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 min-w-0 rounded-lg border border-secondary">
      <Button
        color="tertiary"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full justify-start"
      >
        {label}
      </Button>
      {open && (
        <div className="max-h-[32rem] overflow-auto border-t border-secondary p-3 text-sm whitespace-pre-wrap wrap-anywhere">
          {children}
        </div>
      )}
    </div>
  );
}

export function PiChatMessage({ message }: { message: Message }) {
  return (
    <article
      className="min-w-0 py-4"
      aria-label={
        message.role === "user"
          ? m.pi_chat_you()
          : message.role === "tool"
            ? m.pi_chat_tool_result()
            : m.pi_chat_assistant()
      }
    >
      <p className="mb-2 text-sm font-semibold text-primary">
        {message.role === "user"
          ? m.pi_chat_you()
          : message.role === "tool"
            ? message.toolName || m.pi_chat_tool_result()
            : m.pi_chat_assistant()}
      </p>
      {message.durationMs !== undefined && (
        <p className="mb-2 text-xs text-tertiary">
          {m.pi_chat_duration({ duration: String(Math.round(message.durationMs)) })}
        </p>
      )}
      {message.thinking && <Detail label={m.pi_chat_thinking()}>{message.thinking}</Detail>}
      {message.role === "tool" ? (
        <Detail label={message.isError ? m.pi_chat_tool_error() : m.pi_chat_tool_result()}>
          <pre className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {message.text || m.pi_chat_tool_running()}
          </pre>
        </Detail>
      ) : (
        <div className="prose max-w-none text-sm text-primary [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-3 [&_pre]:text-xs [&_table]:block [&_table]:overflow-auto [&_a]:text-brand-secondary">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {message.text}
          </ReactMarkdown>
        </div>
      )}
      {message.toolCalls?.map((tool) => (
        <Detail key={tool.id} label={tool.name}>
          <pre className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">{tool.input}</pre>
        </Detail>
      ))}
    </article>
  );
}
