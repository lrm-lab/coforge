import { useMemo, type ReactNode } from "react";
import type { RootContent } from "hast";
import { sharedLowlight as highlighter } from "#src/features/records/report-editor/lowlight";
import { m } from "#src/paraglide/messages";
import { PiChatCopy } from "./pi-chat-copy";
import "./pi-chat-code.css";

function tokens(nodes: RootContent[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const classes = node.properties.className;
    return (
      <span key={index} className={Array.isArray(classes) ? classes.join(" ") : undefined}>
        {tokens(node.children)}
      </span>
    );
  });
}

export default function PiChatCodeBlock({ code, language }: { code: string; language: string }) {
  const content = useMemo(() => {
    try {
      return language && highlighter.registered(language)
        ? tokens(highlighter.highlight(language, code).children)
        : code;
    } catch {
      return code;
    }
  }, [code, language]);
  return (
    <div className="not-prose my-3 min-w-0 overflow-hidden rounded-lg border border-secondary">
      <div className="flex items-center justify-between gap-2 border-b border-secondary bg-secondary px-3 py-1">
        <span className="text-xs text-tertiary">{language || m.pi_chat_code()}</span>
        <PiChatCopy text={code} />
      </div>
      <pre className="pi-chat-code m-0 max-h-[32rem] overflow-auto bg-primary p-3 font-mono text-xs text-primary">
        <code>{content}</code>
      </pre>
    </div>
  );
}
