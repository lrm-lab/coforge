import { ProgressBar } from "react-aria-components";
import { RefreshCcw01 as Refresh } from "@untitledui/icons";
import { Spinner } from "#src/components/ui/spinner";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { RecordSidePanelEmpty } from "./record-side-panel-states";
import type {
  KeyPointExtractionMeta,
  ReportBodyRestoreView,
  ReportContent,
} from "./records-content";
import { RecordAssistantSetupCard } from "./record-assistant-setup-card";
import { RecordSideTimeline } from "./record-side-timeline";
import {
  SIDE_PANEL_RESIZE_HANDLE_CLASS,
  SIDE_PANEL_WIDTH_TRANSITION,
} from "./record-side-panel-width";
import { useSidePanelWidth } from "./use-side-panel-width";
import type { RecordSideSurface } from "./record-side-panel-pin";
import { WeeklyTemplateDetailDialog } from "./weekly-template-detail-dialog";
import { RecordSideChatHeader } from "./record-side-chat-header";
import { RecordSideChatComposer } from "./record-side-chat-composer";
import { useRecordSidePanelController } from "./use-record-side-panel-controller";

export type { RecordSideSurface };

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
  countdownUntil?: Date | null;
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
  keyPointExtraction?: KeyPointExtractionMeta;
  keyPointRestartBusy?: boolean;
  onRestartKeyPointExtraction?: () => void;
}) {
  const { asideRef, panelWidth, displayWidth, resizing, resizeHandle } = useSidePanelWidth(open);
  const {
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
    retryLoad,
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
  } = useRecordSidePanelController({
    subjectType,
    subjectId,
    surface,
    refreshToken,
    open,
    onOpenChange,
    onRequestSend,
    onWeekSendDismissed,
    sendOfferActive,
    onBodyApplied,
    bodyRestoreView,
    onSwitchBodyVersion,
  });

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
          className={SIDE_PANEL_RESIZE_HANDLE_CLASS}
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
            <RecordAssistantSetupCard
              workspaceSlug={workspaceSlug}
              agentId={assistantStatus.agentId}
              onDismiss={() => {
                session.setupDismissed = true;
                setSetupDismissed(true);
              }}
            />
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
          <RecordSidePanelEmpty
            loading={initialLoading}
            failed={loadFailed}
            empty={comments.length === 0 && assistantMessages.length === 0}
            onRetry={retryLoad}
          />
          <RecordSideTimeline
            timeline={timeline}
            threadStates={threadStates}
            viewerName={viewerName}
            viewerAvatarUrl={viewer.avatarUrl}
            assistantAvatarUrl={assistantStatus?.avatarUrl}
            busy={busy}
            sendOfferActive={sendOfferActive}
            countdownUntil={countdownUntil}
            appliedSuggestionIds={appliedSuggestionIds}
            dismissedSuggestionIds={dismissedSuggestionIds}
            bodyRestoreView={bodyRestoreView}
            {...timelineActions}
          />

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

        <RecordSideChatComposer
          draft={draft}
          onDraftChange={(value) => {
            session.draft = value;
            setDraft(value);
          }}
          onSubmit={(event) => void onSubmit(event)}
          sendLocked={sendLocked}
          countdownUntil={countdownUntil}
        />
      </div>

      <WeeklyTemplateDetailDialog
        template={templateDetail}
        members={templateMembers}
        onClose={() => setTemplateDetail(null)}
      />
    </aside>
  );
}
