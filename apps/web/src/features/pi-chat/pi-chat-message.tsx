import { lazy, Suspense, useId, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CheckCircle, ChevronDown, ChevronRight, Terminal, XCircle } from "@untitledui/icons";
import type { PiChatMessage as Message } from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { PiChatCopy } from "./pi-chat-copy";
import { usePiChatDisclosure } from "./pi-chat-disclosure";

const CodeBlock = lazy(() => import("./pi-chat-code-block"));

const markdownComponents: Components = {
  pre({ children, node }) {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
    const value = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
    const classes = code.properties.className;
    const language = Array.isArray(classes)
      ? String(classes.find((name) => String(name).startsWith("language-")) ?? "").slice(9)
      : "";
    return (
      <Suspense
        fallback={
          <pre>
            <code>{value}</code>
          </pre>
        }
      >
        <CodeBlock code={value} language={language} />
      </Suspense>
    );
  },
};

function Detail({
  disclosureKey,
  label,
  preview,
  meta,
  children,
  error,
  defaultOpen = false,
}: {
  disclosureKey: string;
  label: string;
  preview?: string;
  meta?: ReactNode;
  children: ReactNode;
  error?: boolean;
  defaultOpen?: boolean;
}) {
  const { open, toggle } = usePiChatDisclosure(disclosureKey, defaultOpen);
  const id = useId();
  return (
    <div className="my-2 min-w-0 overflow-hidden rounded-lg border border-secondary">
      <div className="flex min-w-0 items-center gap-2 bg-secondary pr-3">
        <Button
          color="tertiary"
          size="sm"
          onClick={toggle}
          iconLeading={open ? ChevronDown : ChevronRight}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          className={cn(
            "min-w-0 flex-1 justify-start [&>span[data-text]]:flex [&>span[data-text]]:min-w-0 [&>span[data-text]]:items-center [&>span[data-text]]:gap-2",
            error && "text-error-primary",
          )}
        >
          <span className="max-w-full shrink-0 truncate">{label}</span>{" "}
          {preview && (
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-normal text-tertiary">
              {preview}
            </span>
          )}
        </Button>
        {meta && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-tertiary">{meta}</span>
        )}
      </div>
      {open && (
        <div
          id={id}
          className="max-h-[32rem] overflow-auto border-t border-secondary p-3 text-sm wrap-anywhere"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function inputPreview(input: string) {
  try {
    const args = JSON.parse(input);
    for (const key of ["command", "path", "file_path", "query", "url"])
      if (typeof args?.[key] === "string") return args[key];
  } catch {
    // A streaming argument may not be complete JSON yet.
  }
  return input;
}

function Raw({ text }: { text: string }) {
  return <pre className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">{text}</pre>;
}

export function PiChatMessage({ message }: { message: Message }) {
  const running = message.id.startsWith("running:");
  const Status = message.isError ? XCircle : running ? Terminal : CheckCircle;
  return (
    <div className="min-w-0">
      {message.thinking && (
        <Detail
          disclosureKey={`${message.id}:thinking`}
          label={m.pi_chat_thinking()}
          defaultOpen={message.id === "streaming"}
        >
          <Raw text={message.thinking} />
        </Detail>
      )}
      {message.role === "tool" ? (
        <Detail
          disclosureKey={`${message.id}:result`}
          label={message.toolName || m.pi_chat_tool_result()}
          defaultOpen={running}
          error={message.isError}
          meta={
            <>
              {message.durationMs !== undefined && (
                <span>
                  {m.pi_chat_duration({ duration: String(Math.round(message.durationMs)) })}
                </span>
              )}
              <Status
                aria-label={
                  message.isError
                    ? m.pi_chat_tool_failed()
                    : running
                      ? m.pi_chat_running()
                      : m.pi_chat_tool_done()
                }
                className={cn("size-4", message.isError && "text-error-primary")}
              />
            </>
          }
        >
          {message.text && <Raw text={message.text} />}
          {!message.text && !message.details && (
            <p className="text-xs text-tertiary">
              {running ? m.pi_chat_tool_running() : m.pi_chat_tool_no_output()}
            </p>
          )}
          {message.details && (
            <div className="mt-3 border-t border-secondary pt-3">
              <Raw text={message.details} />
            </div>
          )}
          {(message.text || message.details) && (
            <div className="mt-2 flex justify-end">
              <PiChatCopy text={[message.text, message.details].filter(Boolean).join("\n\n")} />
            </div>
          )}
        </Detail>
      ) : message.text ? (
        <>
          <div className="prose max-w-none text-sm leading-relaxed text-primary [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-3 [&_pre]:text-xs [&_table]:block [&_table]:overflow-auto [&_a]:text-brand-secondary">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={markdownComponents}
            >
              {message.text}
            </ReactMarkdown>
          </div>
          {!message.toolCalls?.length && message.id !== "streaming" && (
            <div className="mt-2 -ml-1.5 flex">
              <PiChatCopy text={message.text} />
            </div>
          )}
        </>
      ) : null}
      {message.toolCalls?.map((tool) => (
        <Detail
          key={tool.id}
          disclosureKey={`${message.id}:${tool.id}`}
          label={tool.name}
          preview={inputPreview(tool.input)}
        >
          <Raw text={tool.input} />
        </Detail>
      ))}
    </div>
  );
}
