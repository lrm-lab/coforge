import { useState, type Dispatch, type SetStateAction } from "react";
import { useServerFn } from "@tanstack/react-start";
import { m } from "#src/paraglide/messages";
import {
  archiveWeeklyReportAssistantChatSessionFn,
  createWeeklyReportAssistantChatSessionFn,
  ensureWeeklyReportAssistantChatSessions,
  renameWeeklyReportAssistantChatSessionFn,
} from "./records-side-chat.functions";
import type { WeeklyReportAssistantSession } from "./weekly-report-assistant-session";

export type ChatSessionRow = Awaited<
  ReturnType<typeof ensureWeeklyReportAssistantChatSessions>
>["sessions"][number];

export function useRecordSideChatSessions({
  subjectType,
  subjectId,
  session,
  busy,
  setBusy,
  setError,
  setDraft,
  chatSessions,
  setChatSessions,
  activeSessionId,
  setActiveSessionId,
  legacySessionId,
  setLegacySessionId,
  loadThread,
}: {
  subjectType: "report" | "cycle";
  subjectId: string;
  session: WeeklyReportAssistantSession;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setDraft: (draft: string) => void;
  chatSessions: ChatSessionRow[];
  setChatSessions: Dispatch<SetStateAction<ChatSessionRow[]>>;
  activeSessionId: string | null;
  setActiveSessionId: (sessionId: string | null) => void;
  legacySessionId: string | null;
  setLegacySessionId: (sessionId: string | null) => void;
  loadThread: (sessionId: string, legacyId: string | null) => Promise<void>;
}) {
  const ensureSessions = useServerFn(ensureWeeklyReportAssistantChatSessions);
  const createSession = useServerFn(createWeeklyReportAssistantChatSessionFn);
  const renameSession = useServerFn(renameWeeklyReportAssistantChatSessionFn);
  const archiveSession = useServerFn(archiveWeeklyReportAssistantChatSessionFn);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  async function onNewChat() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createSession({ data: { subjectType, subjectId } });
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      setChatSessions(ensured.sessions);
      setLegacySessionId(ensured.legacySessionId);
      setActiveSessionId(created.id);
      session.draft = "";
      setDraft("");
      await loadThread(created.id, ensured.legacySessionId);
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  async function onSelectSession(sessionId: string) {
    if (busy || sessionId === activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      setActiveSessionId(sessionId);
      session.draft = "";
      setDraft("");
      await loadThread(sessionId, legacySessionId);
    } finally {
      setBusy(false);
    }
  }

  function openRename() {
    if (!activeSessionId) return;
    const current = chatSessions.find((row) => row.id === activeSessionId);
    const title = current?.title.trim() ?? "";
    setRenameDraft(title);
    setRenameOpen(true);
  }

  async function submitRename() {
    if (!activeSessionId || busy) return;
    const title = renameDraft.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renameSession({ data: { sessionId: activeSessionId, title } });
      setChatSessions((rows) =>
        rows.map((row) => (row.id === updated.id ? { ...row, title: updated.title } : row)),
      );
      setRenameOpen(false);
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSession() {
    if (!activeSessionId || busy) return;
    if (!window.confirm(m.records_side_chat_delete_confirm())) return;
    setBusy(true);
    setError(null);
    try {
      await archiveSession({ data: { sessionId: activeSessionId } });
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      setChatSessions(ensured.sessions);
      setLegacySessionId(ensured.legacySessionId);
      setActiveSessionId(ensured.activeSessionId);
      session.draft = "";
      setDraft("");
      await loadThread(ensured.activeSessionId, ensured.legacySessionId);
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  return {
    onNewChat,
    onSelectSession,
    renameOpen,
    setRenameOpen,
    renameDraft,
    setRenameDraft,
    openRename,
    submitRename,
    onDeleteSession,
  };
}
