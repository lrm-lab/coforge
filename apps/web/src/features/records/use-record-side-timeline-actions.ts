import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { m } from "#src/paraglide/messages";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { loadWorkspaceMembers } from "#src/features/workspaces/members.functions";
import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import type { ReportBodyRestoreView, ReportContent } from "./records-content";
import type { CommentRow } from "./record-side-timeline";
import type { RecordSideSurface } from "./record-side-panel-pin";
import type { WeeklyTemplateDetail } from "./weekly-template-detail-dialog";
import type { TemplateMemberOption } from "./weekly-template-members";
import type { createWeeklyReportAssistantSessionStore } from "./weekly-report-assistant-session";
import type { useAwaitingAssistant } from "./use-awaiting-assistant";
import { isWritingSuggestion, useSuggestionWrite } from "./use-suggestion-write";
import { useRecordRefresh } from "./use-record-refresh";
import { dismissKeyPointConfirmDraft, loadWeeklyTemplateForReport } from "./records.functions";
import {
  acceptMemberGenerateHelp,
  confirmMemberReportIntent,
  declineMemberReportIntent,
  dismissWeeklyFormatSend,
  ensureRecordAssistantIntro,
} from "./records-side-chat.functions";

type SessionStore = ReturnType<typeof createWeeklyReportAssistantSessionStore>;

export function useRecordSideTimelineActions({
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
}: {
  subjectType: "report" | "cycle";
  subjectId: string;
  surface: RecordSideSurface;
  activeSessionId: string | null;
  legacySessionId: string | null;
  sendOfferActive: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setComments: (rows: CommentRow[]) => void;
  appliedSuggestionIds: string[];
  setAppliedSuggestionIds: (ids: string[]) => void;
  dismissedSuggestionIds: string[];
  setDismissedSuggestionIds: (ids: string[]) => void;
  sessionStore: SessionStore;
  sessionKey: string;
  session: ReturnType<SessionStore["get"]>;
  stickToBottomRef: { current: boolean };
  showAwaitingAssistant: ReturnType<typeof useAwaitingAssistant>["show"];
  loadThread: (sessionId: string, legacyId: string | null) => Promise<void>;
  onRequestSend?: () => void;
  onWeekSendDismissed?: () => void;
  onBodyApplied?: (
    reportId: string,
    content: ReportContent,
    restore?: ReportBodyRestoreView | null,
  ) => void;
  onSwitchBodyVersion?: () => void;
}) {
  const refresh = useRecordRefresh();
  const ensureIntro = useServerFn(ensureRecordAssistantIntro);
  const acceptGenerateHelp = useServerFn(acceptMemberGenerateHelp);
  const confirmIntent = useServerFn(confirmMemberReportIntent);
  const declineIntent = useServerFn(declineMemberReportIntent);
  const dismissWeekSend = useServerFn(dismissWeeklyFormatSend);
  const loadTemplateForReport = useServerFn(loadWeeklyTemplateForReport);
  const loadMembers = useServerFn(loadWorkspaceMembers);
  const writeSuggestion = useSuggestionWrite(onBodyApplied);
  const dismissKeyPointsDraft = useServerFn(dismissKeyPointConfirmDraft);
  const [templateDetail, setTemplateDetail] = useState<WeeklyTemplateDetail | null>(null);
  const [templateMembers, setTemplateMembers] = useState<TemplateMemberOption[]>([]);

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

  return {
    templateDetail,
    setTemplateDetail,
    templateMembers,
    timelineActions: {
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
    },
  };
}
