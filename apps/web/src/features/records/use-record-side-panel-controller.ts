import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useConversationRealtime } from "#src/features/conversations/conversation-realtime-client";
import type { ReportBodyRestoreView, ReportContent } from "./records-content";
import { commentThreadStates, sideTimeline } from "./record-side-timeline-model";
import type { CommentRow } from "./record-side-timeline";
import { loadWeeklyReportAssistantContext } from "./records.functions";
import {
  addRecordComment,
  ensureRecordAssistantIntro,
  ensureWeeklyReportAssistantChatSessions,
  loadWeeklyReportAssistantMessages,
  assistantReady,
  loadWeeklyReportAssistantStatus,
  postWeeklyReportAssistantRequest,
} from "./records-side-chat.functions";
import {
  shouldUseMemberReportRulePath,
  looksLikeSynthesizeWeeklyReportRequest,
} from "./weekly-highlight-extract";
import {
  createWeeklyReportAssistantSessionStore,
  weeklyReportAssistantSubjectKey,
  type WeeklyReportAssistantMessage,
} from "./weekly-report-assistant-session";
import {
  readSidePanelPinned,
  writeSidePanelPinned,
  type RecordSideSurface,
} from "./record-side-panel-pin";
import { useAwaitingAssistant } from "./use-awaiting-assistant";
import { useBodyEditRefresh } from "./use-body-edit-refresh";
import { useRecordSideChatSessions, type ChatSessionRow } from "./use-record-side-chat-sessions";
import { useRecordSideTimelineActions } from "./use-record-side-timeline-actions";
import { useSidePanelScroll } from "./use-side-panel-scroll";

const appRoute = getRouteApi("/w/$workspaceSlug");

export function useRecordSidePanelController({
  subjectType,
  subjectId,
  surface,
  refreshToken = 0,
  open,
  onOpenChange,
  onRequestSend,
  onWeekSendDismissed,
  sendOfferActive = false,
  onBodyApplied,
  bodyRestoreView = null,
  onSwitchBodyVersion,
}: {
  subjectType: "report" | "cycle";
  subjectId: string;
  surface: RecordSideSurface;
  refreshToken?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestSend?: () => void;
  onWeekSendDismissed?: () => void;
  sendOfferActive?: boolean;
  onBodyApplied?: (
    reportId: string,
    content: ReportContent,
    restore?: ReportBodyRestoreView | null,
  ) => void;
  bodyRestoreView?: ReportBodyRestoreView | null;
  onSwitchBodyVersion?: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const { user: viewer } = appRoute.useLoaderData();
  const viewerName = viewer.name?.trim() || m.records_side_chat_user();
  const post = useServerFn(addRecordComment);
  const ensureIntro = useServerFn(ensureRecordAssistantIntro);
  const ensureSessions = useServerFn(ensureWeeklyReportAssistantChatSessions);
  const loadAssistantContext = useServerFn(loadWeeklyReportAssistantContext);
  const loadAssistantStatus = useServerFn(loadWeeklyReportAssistantStatus);
  const loadAssistantMessages = useServerFn(loadWeeklyReportAssistantMessages);
  const postAssistantRequest = useServerFn(postWeeklyReportAssistantRequest);
  const [sessionStore] = useState(createWeeklyReportAssistantSessionStore);
  const sessionKey = weeklyReportAssistantSubjectKey(subjectType, subjectId);
  const session = sessionStore.get(sessionKey);
  const [pinned, setPinned] = useState(() => readSidePanelPinned(subjectType, subjectId, surface));
  const [chatSessions, setChatSessions] = useState<ChatSessionRow[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [legacySessionId, setLegacySessionId] = useState<string | null>(null);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<WeeklyReportAssistantMessage[]>(
    session.messages,
  );
  const [assistantStatus, setAssistantStatus] = useState<Awaited<
    ReturnType<typeof loadWeeklyReportAssistantStatus>
  > | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(session.error);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<string[]>(
    session.dismissedSuggestionIds,
  );
  const [appliedSuggestionIds, setAppliedSuggestionIds] = useState<string[]>(
    session.appliedSuggestionIds,
  );
  const {
    active: awaitingSynthesis,
    label: awaitingLabel,
    show: showAwaitingAssistant,
    hide: hideAwaitingAssistant,
    resume: maybeResumeAwaitingAssistant,
  } = useAwaitingAssistant(assistantMessages);
  const [assistantConversationId, setAssistantConversationId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const legacySessionIdRef = useRef<string | null>(null);
  const loadThreadRef = useRef<(sessionId: string, legacyId: string | null) => Promise<void>>(
    async () => {},
  );

  const threadStates = useMemo(() => commentThreadStates(comments), [comments]);
  const timeline = useMemo(
    () => sideTimeline(comments, assistantMessages),
    [assistantMessages, comments],
  );
  const timelineTailId = timeline.at(-1)?.id ?? "";
  const { scrollRef, stickToBottomRef, onThreadScroll } = useSidePanelScroll({
    sessionKey,
    activeSessionId,
    timelineTailId,
    timelineLength: timeline.length,
    awaitingSynthesis,
  });

  useEffect(() => {
    setPinned(readSidePanelPinned(subjectType, subjectId, surface));
  }, [subjectType, subjectId, surface]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setComments([]);
    setAssistantMessages(session.messages);
    setDraft(session.draft);
    setSetupDismissed(session.setupDismissed);
    setError(session.error);
    setDismissedSuggestionIds(session.dismissedSuggestionIds);
    setAppliedSuggestionIds(session.appliedSuggestionIds);
    hideAwaitingAssistant();
    setAssistantConversationId(null);
    setChatSessions([]);
    setActiveSessionId(null);
    setLegacySessionId(null);
  }, [sessionKey]);

  async function loadThread(sessionId: string, legacyId: string | null) {
    const [rows, status, context, chat] = await Promise.all([
      ensureIntro({
        data: { subjectType, subjectId, assistantSessionId: sessionId, surface },
      }),
      loadAssistantStatus().catch(() => null),
      loadAssistantContext({ data: { subjectType, subjectId } }).catch(() => null),
      loadAssistantMessages({
        data: {
          subjectType,
          subjectId,
          sessionId,
          includeLegacyUnscoped: legacyId === sessionId,
        },
      }).catch(() => null),
    ]);
    setComments(rows);
    setAssistantStatus(status);
    session.contextManifest = context;
    const messages = chat
      ? chat.messages.map((message) => ({
          id: message.id,
          body: message.displayBody,
          author: message.author,
          createdAt: message.createdAt,
          suggestion: message.suggestion,
        }))
      : [];
    if (chat) {
      setAssistantConversationId(chat.conversationId);
    }
    session.messages = messages;
    setAssistantMessages(messages);
    maybeResumeAwaitingAssistant(rows, messages);
    stickToBottomRef.current = true;
  }

  useBodyEditRefresh(assistantMessages, bodyRestoreView?.sourceMessageId);

  activeSessionIdRef.current = activeSessionId;
  legacySessionIdRef.current = legacySessionId;
  loadThreadRef.current = loadThread;

  useConversationRealtime(assistantConversationId ?? "", async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    await loadThreadRef.current(sessionId, legacySessionIdRef.current);
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInitialLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const ensured = await ensureSessions({ data: { subjectType, subjectId } });
        if (cancelled) return;
        setChatSessions(ensured.sessions);
        setLegacySessionId(ensured.legacySessionId);
        setActiveSessionId(ensured.activeSessionId);
        await loadThread(ensured.activeSessionId, ensured.legacySessionId);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    subjectType,
    subjectId,
    surface,
    ensureSessions,
    ensureIntro,
    loadAssistantContext,
    loadAssistantMessages,
    loadAssistantStatus,
    refreshToken,
    retryCount,
    session,
  ]);

  useEffect(() => {
    if (!awaitingSynthesis || !activeSessionId) return;
    const timer = window.setInterval(() => {
      void loadThread(activeSessionId, legacySessionId);
    }, 4000);
    const timeout = window.setTimeout(() => {
      hideAwaitingAssistant();
    }, 180_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, [awaitingSynthesis, activeSessionId, legacySessionId]);

  const sessionActions = useRecordSideChatSessions({
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
  });

  function togglePinned() {
    const next = !pinned;
    setPinned(next);
    writeSidePanelPinned(subjectType, subjectId, next);
  }

  function requestCollapse() {
    onOpenChange(false);
  }

  const { templateDetail, setTemplateDetail, templateMembers, timelineActions } =
    useRecordSideTimelineActions({
      subjectType,
      subjectId,
      surface,
      activeSessionId,
      legacySessionId,
      sendOfferActive,
      busy,
      setBusy,
      setError,
      setComments,
      appliedSuggestionIds,
      setAppliedSuggestionIds,
      dismissedSuggestionIds,
      setDismissedSuggestionIds,
      sessionStore,
      sessionKey,
      session,
      stickToBottomRef,
      showAwaitingAssistant,
      loadThread,
      onRequestSend,
      onWeekSendDismissed,
      onBodyApplied,
      onSwitchBodyVersion,
    });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy || awaitingSynthesis || !activeSessionId) return;
    stickToBottomRef.current = true;
    setBusy(true);
    setError(null);
    session.error = null;
    try {
      const useRulePath =
        shouldUseMemberReportRulePath(surface, body) || !assistantReady(assistantStatus);
      if (useRulePath) {
        if (!assistantReady(assistantStatus)) {
          session.setupDismissed = false;
          setSetupDismissed(false);
        }
        const rows = await post({
          data: { subjectType, subjectId, body, assistantSessionId: activeSessionId },
        });
        session.draft = "";
        setDraft("");
        setComments(rows);
        if (looksLikeSynthesizeWeeklyReportRequest(body)) {
          void loadThread(activeSessionId, legacySessionId);
        }
        const ensured = await ensureSessions({ data: { subjectType, subjectId } });
        setChatSessions(ensured.sessions);
        return;
      }

      const result = await postAssistantRequest({
        data: {
          subjectType,
          subjectId,
          sessionId: activeSessionId,
          body,
          requestId: crypto.randomUUID(),
        },
      });
      if (result.kind === "needs_setup") {
        setAssistantStatus(result.status);
        session.setupDismissed = false;
        setSetupDismissed(false);
        return;
      }
      if (result.kind === "rule") {
        session.draft = "";
        setDraft("");
        setComments(result.comments);
        const ensured = await ensureSessions({ data: { subjectType, subjectId } });
        setChatSessions(ensured.sessions);
        return;
      }

      session.draft = "";
      setDraft("");
      showAwaitingAssistant(Date.now(), null);
      const chat = await loadAssistantMessages({
        data: {
          subjectType,
          subjectId,
          sessionId: activeSessionId,
          includeLegacyUnscoped: legacySessionId === activeSessionId,
        },
      });
      setAssistantConversationId(chat.conversationId);
      const refreshed = chat.messages.map((message) => ({
        id: message.id,
        body: message.displayBody,
        author: message.author,
        createdAt: message.createdAt,
        suggestion: message.suggestion,
      }));
      session.messages = refreshed;
      setAssistantMessages(refreshed);
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      setChatSessions(ensured.sessions);
    } catch {
      const message = m.records_weekly_ai_request_failed();
      session.error = message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const totalCount = comments.length + assistantMessages.length;
  const activeSession = chatSessions.find((row) => row.id === activeSessionId);
  const sessionTitle = activeSession?.title.trim() || m.records_side_chat_untitled();
  const sendLocked = busy || awaitingSynthesis;

  return {
    workspaceSlug,
    viewer,
    viewerName,
    session,
    pinned,
    togglePinned,
    requestCollapse,
    templateDetail,
    setTemplateDetail,
    templateMembers,
    chatSessions,
    activeSessionId,
    sessionTitle,
    totalCount,
    sessionActions,
    scrollRef,
    onThreadScroll,
    assistantStatus,
    setupDismissed,
    setSetupDismissed,
    initialLoading,
    loadFailed,
    retryLoad: () => setRetryCount((n) => n + 1),
    error,
    comments,
    assistantMessages,
    timeline,
    threadStates,
    busy,
    appliedSuggestionIds,
    dismissedSuggestionIds,
    timelineActions,
    awaitingSynthesis,
    awaitingLabel,
    draft,
    setDraft,
    onSubmit,
    sendLocked,
  };
}
