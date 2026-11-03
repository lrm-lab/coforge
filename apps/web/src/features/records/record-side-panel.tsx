import { ProgressBar } from "react-aria-components";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Microphone02 as Microphone,
  Paperclip,
  RefreshCcw01 as Refresh,
  Send01 as Send,
} from "@untitledui/icons";
import { Spinner } from "#src/components/ui/spinner";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { TextArea } from "#src/components/base/textarea/textarea";
import { m } from "#src/paraglide/messages";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cx } from "#src/utils/cx";
import { shouldSendOnEnter } from "#src/features/conversations/composer-behavior";
import { useConversationRealtime } from "#src/features/conversations/conversation-realtime-client";
import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import type {
  KeyPointExtractionMeta,
  ReportBodyRestoreView,
  ReportContent,
} from "./records-content";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import { SendCountdownBadge } from "./record-side-panel-cards";
import { commentThreadStates, sideTimeline } from "./record-side-timeline-model";
import { RecordSideTimeline, type CommentRow } from "./record-side-timeline";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { SIDE_PANEL_WIDTH_TRANSITION } from "./record-side-panel-width";
import { useSidePanelWidth } from "./use-side-panel-width";
import { isWritingSuggestion, useSuggestionWrite } from "./use-suggestion-write";
import {
  dismissKeyPointConfirmDraft,
  loadWeeklyTemplateForReport,
  loadWeeklyReportAssistantContext,
} from "./records.functions";
import {
  addRecordComment,
  acceptMemberGenerateHelp,
  confirmMemberReportIntent,
  declineMemberReportIntent,
  ensureRecordAssistantIntro,
  ensureWeeklyReportAssistantChatSessions,
  dismissWeeklyFormatSend,
  loadWeeklyReportAssistantMessages,
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
import { loadWorkspaceMembers } from "#src/features/workspaces/members.functions";
import {
  WeeklyTemplateDetailDialog,
  type WeeklyTemplateDetail,
} from "./weekly-template-detail-dialog";
import type { TemplateMemberOption } from "./weekly-template-members";
import { useRecordRefresh } from "./use-record-refresh";
import { RecordSideChatHeader } from "./record-side-chat-header";
import { useRecordSideChatSessions, type ChatSessionRow } from "./use-record-side-chat-sessions";

export type { RecordSideSurface };

const appRoute = getRouteApi("/w/$workspaceSlug");

function assistantReady(
  status: Awaited<ReturnType<typeof loadWeeklyReportAssistantStatus>> | null,
) {
  return Boolean(status?.computerConfigured && status.runtimeConfigured);
}

export function RecordSidePanel({
  subjectType,
  subjectId,
  surface,
  countdownUntil,
  refreshToken = 0,
  open,
  onOpenChange,
  onRequestSend,
  onWeekSendDismissed,
  sendOfferActive = false,
  onBodyApplied,
  bodyRestoreView = null,
  onSwitchBodyVersion,
  keyPointExtraction,
  keyPointRestartBusy,
  onRestartKeyPointExtraction,
}: {
  subjectType: "report" | "cycle";
  subjectId: string;
  surface: RecordSideSurface;
  /** End of the open send window; the panel renders the countdown itself. */
  countdownUntil?: Date | null;
  refreshToken?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestSend?: () => void;
  /** After Leader dismisses this week's send from the offer-send card. */
  onWeekSendDismissed?: () => void;
  /** Whether the format can still be sent (hides offer actions when false). */
  sendOfferActive?: boolean;
  /** After a body-edit write or version switch, parent syncs the open editor. */
  onBodyApplied?: (
    reportId: string,
    content: ReportContent,
    restore?: ReportBodyRestoreView | null,
  ) => void;
  bodyRestoreView?: ReportBodyRestoreView | null;
  onSwitchBodyVersion?: () => void;
  /** Leader member-report: show personal key-point status + re-extract. */
  keyPointExtraction?: KeyPointExtractionMeta;
  keyPointRestartBusy?: boolean;
  onRestartKeyPointExtraction?: () => void;
}) {
  const refresh = useRecordRefresh();
  const workspaceSlug = useWorkspaceSlug();
  const { user: viewer } = appRoute.useLoaderData();
  // The viewer's name, never their username.
  const viewerName = viewer.name?.trim() || m.records_side_chat_user();
  const post = useServerFn(addRecordComment);
  const ensureIntro = useServerFn(ensureRecordAssistantIntro);
  const ensureSessions = useServerFn(ensureWeeklyReportAssistantChatSessions);
  const acceptGenerateHelp = useServerFn(acceptMemberGenerateHelp);
  const confirmIntent = useServerFn(confirmMemberReportIntent);
  const declineIntent = useServerFn(declineMemberReportIntent);
  const dismissWeekSend = useServerFn(dismissWeeklyFormatSend);
  const loadTemplateForReport = useServerFn(loadWeeklyTemplateForReport);
  const loadMembers = useServerFn(loadWorkspaceMembers);
  const loadAssistantContext = useServerFn(loadWeeklyReportAssistantContext);
  const loadAssistantStatus = useServerFn(loadWeeklyReportAssistantStatus);
  const loadAssistantMessages = useServerFn(loadWeeklyReportAssistantMessages);
  const postAssistantRequest = useServerFn(postWeeklyReportAssistantRequest);
  const writeSuggestion = useSuggestionWrite(onBodyApplied);
  const dismissKeyPointsDraft = useServerFn(dismissKeyPointConfirmDraft);
  const [sessionStore] = useState(createWeeklyReportAssistantSessionStore);
  const sessionKey = weeklyReportAssistantSubjectKey(subjectType, subjectId);
  const session = sessionStore.get(sessionKey);
  const [pinned, setPinned] = useState(() => readSidePanelPinned(subjectType, subjectId, surface));
  const [templateDetail, setTemplateDetail] = useState<WeeklyTemplateDetail | null>(null);
  const [templateMembers, setTemplateMembers] = useState<TemplateMemberOption[]>([]);
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
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const scrollReleaseTimerRef = useRef<number | null>(null);
  const { asideRef, panelWidth, displayWidth, resizing, resizeHandle } = useSidePanelWidth(open);

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
    // After async load (incl. refresh), pin to latest turn once layout commits.
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
    void (async () => {
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      if (cancelled) return;
      setChatSessions(ensured.sessions);
      setLegacySessionId(ensured.legacySessionId);
      setActiveSessionId(ensured.activeSessionId);
      await loadThread(ensured.activeSessionId, ensured.legacySessionId);
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

  async function onDismissWeekSend() {
    if (busy || subjectType !== "report" || !sendOfferActive) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await dismissWeekSend({
        data: {
          reportId: subjectId,
          assistantSessionId: activeSessionId ?? undefined,
        },
      });
      setComments(rows);
      onWeekSendDismissed?.();
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  async function openTemplateDetail() {
    if (busy || subjectType !== "report") return;
    setBusy(true);
    setError(null);
    try {
      const [template, directory] = await Promise.all([
        loadTemplateForReport({ data: { reportId: subjectId } }),
        loadMembers(),
      ]);
      setTemplateMembers(directory.members);
      setTemplateDetail(template);
    } catch {
      setError(m.records_template_detail_failed());
    } finally {
      setBusy(false);
    }
  }

  function dismissSuggestion(messageId: string) {
    const next = sessionStore.markSuggestionDismissed(sessionKey, messageId);
    setDismissedSuggestionIds(next);
  }

  async function onIgnoreSuggestion(
    messageId: string,
    suggestion: WeeklyReportAssistantSuggestion,
  ) {
    if (busy || appliedSuggestionIds.includes(messageId)) return;
    if (dismissedSuggestionIds.includes(messageId)) return;
    dismissSuggestion(messageId);
    if (suggestion.type !== "key-point-edit") return;
    setBusy(true);
    setError(null);
    try {
      await dismissKeyPointsDraft({ data: { reportId: suggestion.reportId } });
      await refresh.record();
    } catch {
      // Card is already frozen locally; keep page refresh best-effort.
    } finally {
      setBusy(false);
    }
  }

  function markSuggestionApplied(messageId: string) {
    const next = sessionStore.markSuggestionApplied(sessionKey, messageId);
    setAppliedSuggestionIds(next);
  }

  async function confirmSuggestion(messageId: string, suggestion: WeeklyReportAssistantSuggestion) {
    if (busy) return;
    if (appliedSuggestionIds.includes(messageId)) return;
    if (suggestion.type === "send-prompt") {
      onRequestSend?.();
      return;
    }
    if (!isWritingSuggestion(suggestion)) {
      dismissSuggestion(messageId);
      return;
    }
    setBusy(true);
    setError(null);
    session.error = null;
    try {
      const reload = await writeSuggestion(messageId, suggestion);
      markSuggestionApplied(messageId);
      await reload();
    } catch {
      const message = m.records_assistant_write_failed();
      session.error = message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const send = shouldSendOnEnter(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing || isComposingRef.current,
        keyCode: event.keyCode,
      },
      { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() },
      { newlineModifier: "ctrl" },
    );
    if (!send) return;
    event.preventDefault();
    void onSubmit(event as unknown as FormEvent);
  }

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

  async function onAcceptGenerateHelp() {
    if (subjectType !== "report" || busy || !activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await acceptGenerateHelp({
        data: { reportId: subjectId, assistantSessionId: activeSessionId },
      });
      setComments(rows);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmIntent(intent: "collect-again" | "synthesize", userGuidance?: string) {
    if (subjectType !== "report" || busy || !activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await confirmIntent({
        data: {
          reportId: subjectId,
          assistantSessionId: activeSessionId,
          intent,
          ...(userGuidance ? { userGuidance } : {}),
        },
      });
      setComments(rows);
      if (intent === "synthesize") {
        stickToBottomRef.current = true;
        showAwaitingAssistant(Date.now(), null);
        await loadThread(activeSessionId, legacySessionId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDeclineIntent() {
    if (subjectType !== "report" || busy || !activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await declineIntent({
        data: { reportId: subjectId, assistantSessionId: activeSessionId },
      });
      setComments(result.comments);
      if (result.forwarded) {
        stickToBottomRef.current = true;
        showAwaitingAssistant(Date.now(), null);
        await loadThread(activeSessionId, legacySessionId);
      }
    } finally {
      setBusy(false);
    }
  }

  const totalCount = comments.length + assistantMessages.length;
  const activeSession = chatSessions.find((row) => row.id === activeSessionId);
  const sessionTitle = activeSession?.title.trim() || m.records_side_chat_untitled();

  const threadStates = useMemo(() => commentThreadStates(comments), [comments]);
  const timeline = useMemo(
    () => sideTimeline(comments, assistantMessages),
    [assistantMessages, comments],
  );

  const timelineTailId = timeline.at(-1)?.id ?? "";
  const sendLocked = busy || awaitingSynthesis;

  function scrollThreadToBottom(behavior: ScrollBehavior = "auto") {
    const scroller = scrollRef.current;
    if (!scroller) return;
    programmaticScrollRef.current = true;
    if (scrollReleaseTimerRef.current != null) {
      window.clearTimeout(scrollReleaseTimerRef.current);
      scrollReleaseTimerRef.current = null;
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    scroller.scrollTop = scroller.scrollHeight;
    // Ignore scroll events from our own move so stick-to-bottom is not cleared mid-flight.
    const releaseMs = behavior === "smooth" ? 450 : 0;
    scrollReleaseTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      scrollReleaseTimerRef.current = null;
    }, releaseMs);
  }

  function onThreadScroll() {
    if (programmaticScrollRef.current) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    stickToBottomRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 72;
  }

  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    scrollThreadToBottom("auto");
  }, [sessionKey, activeSessionId]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    // Jump, don't animate: smooth mid-scroll used to clear stick-to-bottom via onScroll.
    scrollThreadToBottom("auto");
  }, [timelineTailId, timeline.length, awaitingSynthesis]);

  // Collect cards / images can grow after the first paint; keep pinned while sticking.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      scrollThreadToBottom("auto");
    });
    observer.observe(scroller);
    for (const child of scroller.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [timelineTailId, timeline.length]);

  useEffect(() => {
    return () => {
      if (scrollReleaseTimerRef.current != null) {
        window.clearTimeout(scrollReleaseTimerRef.current);
      }
    };
  }, []);

  // Handlers that keep their identity, so the memoized thread renders only when what it shows
  // changes.
  const timelineActions = {
    openTemplateDetail: useLatestCallback(openTemplateDetail),
    onRequestSend: useLatestCallback(onRequestSend),
    onDismissWeekSend: useLatestCallback(onDismissWeekSend),
    onAcceptGenerateHelp: useLatestCallback(onAcceptGenerateHelp),
    onConfirmIntent: useLatestCallback(onConfirmIntent),
    onDeclineIntent: useLatestCallback(onDeclineIntent),
    onCollectPlanSubmitted: useLatestCallback(() => {
      if (!activeSessionId) return;
      void ensureIntro({
        data: {
          subjectType,
          subjectId,
          assistantSessionId: activeSessionId,
          surface,
        },
      }).then((rows) => setComments(rows));
    }),
    onCollectAdvanced: useLatestCallback(() => {
      if (!activeSessionId) return;
      void loadThread(activeSessionId, legacySessionId);
    }),
    confirmSuggestion: useLatestCallback(confirmSuggestion),
    onIgnoreSuggestion: useLatestCallback(onIgnoreSuggestion),
    onSwitchBodyVersion: useLatestCallback(onSwitchBodyVersion),
  };

  return (
    <aside
      ref={asideRef}
      style={{
        width: displayWidth,
        transition: resizing ? "none" : SIDE_PANEL_WIDTH_TRANSITION,
      }}
      aria-hidden={!open}
      className={cx(
        "relative flex shrink-0 flex-col overflow-hidden bg-primary",
        open || displayWidth > 0 ? "border-l border-secondary" : "border-l-0",
      )}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={{ width: panelWidth, minWidth: panelWidth }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={m.controls_resize_sidebar()}
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={open ? 0 : -1}
          {...resizeHandle}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-brand-solid/20 active:bg-brand-solid/30"
        />
        <RecordSideChatHeader
          busy={busy}
          chatSessions={chatSessions}
          activeSessionId={activeSessionId}
          sessionTitle={sessionTitle}
          totalCount={totalCount}
          pinned={pinned}
          actions={sessionActions}
          onTogglePinned={togglePinned}
          onCollapse={requestCollapse}
        />

        <div
          ref={scrollRef}
          onScroll={onThreadScroll}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-2"
        >
          {assistantStatus &&
          (!assistantStatus.computerConfigured || !assistantStatus.runtimeConfigured) &&
          !setupDismissed ? (
            <div className="space-y-3 rounded-xl border border-secondary bg-warning-primary p-3">
              <div>
                <p className="text-sm font-semibold text-primary">
                  {m.records_weekly_ai_setup_title()}
                </p>
                <p className="mt-1 text-sm text-secondary">
                  {m.records_weekly_ai_setup_description()}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/w/$workspaceSlug/members"
                  params={{ workspaceSlug }}
                  search={{
                    profile: formatAgentProfileParam(assistantStatus.agentId),
                    agentTab: "profile",
                  }}
                  className="text-sm font-semibold text-brand-secondary"
                >
                  {m.records_weekly_ai_setup_action()}
                </Link>
                <Button
                  size="sm"
                  color="tertiary"
                  onPress={() => {
                    session.setupDismissed = true;
                    setSetupDismissed(true);
                  }}
                >
                  {m.records_weekly_ai_setup_dismiss()}
                </Button>
              </div>
            </div>
          ) : null}
          {keyPointExtraction &&
          (keyPointExtraction.status === "ready" ||
            keyPointExtraction.status === "failed" ||
            keyPointExtraction.status === "pending_setup") ? (
            <div className="space-y-3 rounded-xl border border-secondary bg-secondary_subtle p-3">
              <div>
                <p className="text-sm font-semibold text-primary">
                  {keyPointExtraction.status === "ready"
                    ? m.records_key_points_side_ready_title()
                    : m.records_key_points_restart()}
                </p>
                <p className="mt-1 text-sm text-secondary">
                  {keyPointExtraction.status === "ready"
                    ? m.records_key_points_side_ready()
                    : keyPointExtraction.status === "pending_setup"
                      ? m.records_key_points_side_pending()
                      : m.records_key_points_side_failed()}
                </p>
              </div>
              {onRestartKeyPointExtraction ? (
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={Refresh}
                  isDisabled={keyPointRestartBusy}
                  onPress={() => onRestartKeyPointExtraction()}
                >
                  {m.records_key_points_restart()}
                </Button>
              ) : null}
            </div>
          ) : null}
          {keyPointExtraction?.status === "generating" ? (
            <p className="text-sm text-tertiary">{m.records_key_points_generating()}</p>
          ) : null}
          {error ? <p className="text-sm text-error-primary">{error}</p> : null}
          {comments.length === 0 && assistantMessages.length === 0 ? (
            <p className="text-sm text-tertiary">{m.records_side_chat_empty()}</p>
          ) : null}
          <RecordSideTimeline
            timeline={timeline}
            threadStates={threadStates}
            viewerName={viewerName}
            viewerAvatarUrl={viewer.avatarUrl}
            busy={busy}
            sendOfferActive={sendOfferActive}
            countdownUntil={countdownUntil}
            appliedSuggestionIds={appliedSuggestionIds}
            dismissedSuggestionIds={dismissedSuggestionIds}
            bodyRestoreView={bodyRestoreView}
            {...timelineActions}
          />

          {/* Keep latest bubbles above the composer so they are not flush against the edge. */}
          <div className="h-20 shrink-0" aria-hidden />
        </div>

        {awaitingSynthesis ? (
          <div className="flex items-center gap-2 border-t border-secondary px-4 py-2">
            <ProgressBar
              isIndeterminate
              aria-label={awaitingLabel ?? m.records_side_chat_assistant_running()}
              className="inline-flex shrink-0 text-brand-secondary"
            >
              <Spinner className="size-4" />
            </ProgressBar>
            <span className="text-xs text-tertiary">
              {awaitingLabel ?? m.records_side_chat_assistant_running()}
            </span>
          </div>
        ) : null}

        <form onSubmit={(event) => void onSubmit(event)} className="border-t border-secondary p-3">
          <div className="flex items-end gap-2 rounded-lg border border-secondary bg-primary p-1.5 shadow-xs">
            <ButtonUtility
              type="button"
              size="sm"
              color="tertiary"
              icon={Paperclip}
              aria-label={m.records_side_chat_attach()}
              isDisabled
            />
            <TextArea
              aria-label={m.records_side_chat_placeholder()}
              value={draft}
              onChange={(value) => {
                session.draft = value;
                setDraft(value);
              }}
              onTextAreaKeyDown={onComposerKeyDown}
              onTextAreaCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onTextAreaCompositionEnd={() => {
                isComposingRef.current = false;
                lastCompositionEndAtRef.current = Date.now();
              }}
              placeholder={
                sendLocked
                  ? m.records_side_chat_placeholder_busy()
                  : m.records_side_chat_placeholder()
              }
              rows={1}
              textAreaClassName="resize-none border-0 bg-transparent p-1 shadow-none ring-0 focus:ring-0"
              className="min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-1">
              <SendCountdownBadge until={countdownUntil} />
              <ButtonUtility
                type="button"
                size="sm"
                color="tertiary"
                icon={Microphone}
                aria-label={m.records_side_chat_voice()}
                isDisabled
              />
              <ButtonUtility
                type="submit"
                size="sm"
                color="secondary"
                icon={Send}
                className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                aria-label={m.records_side_chat_send()}
                isDisabled={sendLocked || !draft.trim()}
              />
            </div>
          </div>
        </form>
      </div>

      <WeeklyTemplateDetailDialog
        template={templateDetail}
        members={templateMembers}
        onClose={() => setTemplateDetail(null)}
      />
    </aside>
  );
}
