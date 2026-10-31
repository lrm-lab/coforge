import { useEffect, useRef, useState } from "react";

import {
  resolveAwaitingAssistantResume,
  type AwaitingAssistantResume,
  type AwaitingResumeComment,
  type AwaitingResumeMessage,
} from "./record-side-panel-awaiting";
import { useRecordRefresh } from "./use-record-refresh";

/**
 * Whether the side panel shows that the assistant is working, and with which label. `show` when a
 * request is sent, `resume` when a load finds one still pending (`resolveAwaitingAssistantResume`).
 * It hides itself once an assistant message newer than the request arrives, and reads the report
 * pages again then: the reply may have changed the report and what the sidebar shows of it.
 */
export function useAwaitingAssistant(assistantMessages: readonly AwaitingResumeMessage[]) {
  const refresh = useRecordRefresh();
  const [awaiting, setAwaiting] = useState<AwaitingAssistantResume | null>(null);
  // The same, for the code that reads it in the turn that changed it.
  const awaitingRef = useRef<AwaitingAssistantResume | null>(null);
  function set(next: AwaitingAssistantResume | null) {
    awaitingRef.current = next;
    setAwaiting(next);
  }
  const show = (pendingAt: number, label: string | null) => set({ pendingAt, label });
  const hide = () => set(null);
  function resume(
    comments: readonly AwaitingResumeComment[],
    messages: readonly AwaitingResumeMessage[],
  ) {
    const pending = resolveAwaitingAssistantResume(comments, messages);
    if (pending) return show(pending.pendingAt, pending.label);
    const label = awaitingRef.current?.label;
    if (label != null && /请稍候/.test(label)) hide();
  }

  const active = awaiting !== null;
  useEffect(() => {
    const startedAt = awaitingRef.current?.pendingAt;
    if (!active || startedAt == null) return;
    const hasNewAssistant = assistantMessages.some(
      (message) => message.author === "assistant" && Date.parse(message.createdAt) > startedAt,
    );
    if (hasNewAssistant) {
      hide();
      void refresh.records();
    }
  }, [assistantMessages, active, refresh]);

  return { active, label: awaiting?.label ?? null, show, hide, resume };
}
