import { memo } from "react";

import { Button } from "#src/components/base/buttons/button";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { m } from "#src/paraglide/messages";
import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import type { ReportBodyRestoreView } from "./records-content";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import {
  AssistantAttachmentCard,
  AutoSendCountdown,
  FormatSendActions,
} from "./record-side-panel-cards";
import { suggestionPreview } from "./record-side-panel-model";
import type { commentThreadStates, sideTimeline } from "./record-side-timeline-model";
import type { ensureRecordAssistantIntro } from "./records-side-chat.functions";
import type { WeeklyReportAssistantMessage } from "./weekly-report-assistant-session";
import { WeeklyReportCollectPlanCard } from "./weekly-report-collect-plan-card";
import { WeeklyReportCollectRunCard } from "./weekly-report-collect-run-card";
import { WeeklyReportMessageCard } from "./weekly-report-message-card";

export type CommentRow = Awaited<ReturnType<typeof ensureRecordAssistantIntro>>[number];

/**
 * The Record side panel's thread: its comments and assistant messages, each with the card it
 * carries. Memoized, with handlers that keep their identity, so typing in the composer or the
 * send countdown's tick does not render the whole thread again (task #366).
 */
export const RecordSideTimeline = memo(function RecordSideTimeline({
  timeline,
  threadStates,
  viewerName,
  viewerAvatarUrl,
  busy,
  sendOfferActive,
  countdownUntil,
  appliedSuggestionIds,
  dismissedSuggestionIds,
  bodyRestoreView,
  openTemplateDetail,
  onRequestSend,
  onDismissWeekSend,
  onAcceptGenerateHelp,
  onConfirmIntent,
  onDeclineIntent,
  onCollectPlanSubmitted,
  onCollectAdvanced,
  confirmSuggestion,
  onIgnoreSuggestion,
  onSwitchBodyVersion,
}: {
  timeline: ReturnType<typeof sideTimeline<CommentRow, WeeklyReportAssistantMessage>>;
  threadStates: ReturnType<typeof commentThreadStates>;
  viewerName: string;
  viewerAvatarUrl: string | null | undefined;
  busy: boolean;
  sendOfferActive: boolean | undefined;
  countdownUntil: Date | null | undefined;
  appliedSuggestionIds: readonly string[];
  dismissedSuggestionIds: readonly string[];
  bodyRestoreView: ReportBodyRestoreView | null | undefined;
  openTemplateDetail: () => Promise<void>;
  onRequestSend: (() => void) | undefined;
  onDismissWeekSend: () => Promise<void>;
  onAcceptGenerateHelp: () => Promise<void>;
  onConfirmIntent: (intent: "collect-again" | "synthesize", userGuidance?: string) => Promise<void>;
  onDeclineIntent: () => Promise<void>;
  onCollectPlanSubmitted: () => void;
  onCollectAdvanced: () => void;
  confirmSuggestion: (
    messageId: string,
    suggestion: WeeklyReportAssistantSuggestion,
  ) => Promise<void>;
  onIgnoreSuggestion: (
    messageId: string,
    suggestion: WeeklyReportAssistantSuggestion,
  ) => Promise<void>;
  onSwitchBodyVersion: (() => void) | undefined;
}) {
  return (
    <>
      {timeline.map((item) => {
        if (item.source === "comment") {
          const comment = item.comment;
          const authorName =
            comment.authorType === "assistant"
              ? m.records_side_chat_assistant()
              : comment.authorType === "system"
                ? m.records_side_chat_system()
                : comment.author?.displayName?.trim() ||
                  comment.author?.username?.trim() ||
                  viewerName;
          const state = threadStates.byId.get(comment.id)!;
          const payload = state.payload;
          const offerResolved =
            payload?.kind === "offer-send" && (!sendOfferActive || state.offerSuperseded);
          return (
            <article key={item.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <IdentityAvatar
                  size="xs"
                  name={authorName}
                  alt={authorName}
                  src={comment.author?.avatarUrl}
                />
                <span className="text-sm font-medium text-primary">{authorName}</span>
                <span className="ml-auto text-xs text-tertiary">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-primary">{comment.body}</p>
              {payload?.kind === "offer-send" ? (
                <div className="space-y-3">
                  <AssistantAttachmentCard
                    payload={payload}
                    disabled={busy}
                    onOpen={() => void openTemplateDetail()}
                  />
                  <div className={`space-y-2 ${offerResolved ? "opacity-60" : ""}`}>
                    <FormatSendActions
                      disabled={busy || offerResolved}
                      onSend={() => onRequestSend?.()}
                      onCancel={() => void onDismissWeekSend()}
                    />
                    {offerResolved ? null : <AutoSendCountdown until={countdownUntil} />}
                  </div>
                </div>
              ) : null}
              {payload?.kind === "offer-help-generate" && !threadStates.generateHelpConsumed ? (
                <Button
                  size="sm"
                  color="primary"
                  className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                  isDisabled={busy}
                  onPress={() => void onAcceptGenerateHelp()}
                >
                  {m.records_assistant_need_help()}
                </Button>
              ) : null}
              {payload?.kind === "confirm-intent" && !state.intentResolved ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    color="primary"
                    className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                    isDisabled={busy}
                    onPress={() => void onConfirmIntent(payload.intent, payload.userGuidance)}
                  >
                    {m.records_assistant_confirm_yes()}
                  </Button>
                  <Button
                    size="sm"
                    color="secondary"
                    isDisabled={busy}
                    onPress={() => void onDeclineIntent()}
                  >
                    {m.records_assistant_confirm_no()}
                  </Button>
                </div>
              ) : null}
              {payload?.kind === "collect-plan" ? (
                <WeeklyReportCollectPlanCard
                  storageKey={comment.id}
                  reportId={payload.reportId}
                  year={payload.year}
                  week={payload.week}
                  disabled={state.collectRunFollows}
                  onSubmitted={onCollectPlanSubmitted}
                />
              ) : null}
              {payload?.kind === "collect-run" && state.firstOfCollectRun ? (
                <WeeklyReportCollectRunCard
                  runId={payload.runId}
                  onCollectAdvanced={onCollectAdvanced}
                />
              ) : null}
            </article>
          );
        }

        const message = item.message;
        const authorName =
          message.author === "assistant" ? m.records_side_chat_assistant() : viewerName;
        const suggestion = message.suggestion ?? null;
        const showSuggestion =
          suggestion !== null &&
          (suggestion.type === "body-edit" ||
            suggestion.type === "key-point-edit" ||
            suggestion.type === "template-create");
        const suggestionApplied = appliedSuggestionIds.includes(message.id);
        const suggestionDismissed = dismissedSuggestionIds.includes(message.id);
        const writtenByServer =
          suggestion?.type === "body-edit" && bodyRestoreView?.sourceMessageId === message.id;
        const suggestionFrozen = suggestionApplied || suggestionDismissed || writtenByServer;
        const preview = showSuggestion && suggestion ? suggestionPreview(suggestion) : "";
        return (
          <article key={item.id} className="space-y-2">
            <div className="flex items-center gap-2">
              <IdentityAvatar
                size="xs"
                alt={authorName}
                name={authorName}
                // The assistant has no cartoon person (initial only); the viewer's face is theirs.
                src={message.author === "assistant" ? undefined : viewerAvatarUrl}
              />
              <span className="text-sm font-medium text-primary">{authorName}</span>
              <span className="ml-auto text-xs text-tertiary">
                {new Date(message.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-primary">{message.body}</p>
            {suggestion?.type === "collect-plan" ? (
              <WeeklyReportMessageCard
                messageId={message.id}
                suggestion={suggestion}
                disabled={suggestionFrozen}
              />
            ) : null}
            {suggestion?.type === "send-prompt" && !suggestionFrozen ? (
              <FormatSendActions
                disabled={busy}
                onSend={() => void confirmSuggestion(message.id, suggestion)}
                onCancel={() => {
                  void onIgnoreSuggestion(message.id, suggestion);
                  void onDismissWeekSend();
                }}
              />
            ) : null}
            {showSuggestion && suggestion ? (
              <div
                className={`space-y-2 rounded-lg border p-3 ${
                  suggestionFrozen
                    ? "border-secondary bg-secondary opacity-80"
                    : "border-secondary bg-secondary"
                }`}
              >
                {suggestionDismissed ? (
                  <p className="text-sm font-medium text-tertiary">
                    {m.records_assistant_suggestion_ignored()}
                  </p>
                ) : null}
                {(suggestionApplied || writtenByServer) && !suggestionDismissed ? (
                  <p className="text-sm font-medium text-tertiary">
                    {m.records_assistant_suggestion_inserted()}
                  </p>
                ) : null}
                <p className="text-sm font-medium text-primary">{suggestion.summary}</p>
                {preview ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-tertiary">
                      {suggestion.type === "key-point-edit"
                        ? m.records_key_points_suggestion_preview()
                        : m.records_assistant_suggestion_preview()}
                    </p>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-primary p-2 text-xs text-secondary">
                      {preview}
                    </pre>
                  </div>
                ) : null}
                {writtenByServer && bodyRestoreView && onSwitchBodyVersion ? (
                  <Button
                    size="sm"
                    color="secondary"
                    isDisabled={busy}
                    onPress={onSwitchBodyVersion}
                  >
                    {bodyRestoreView.showing === "latest"
                      ? m.records_body_restore_previous()
                      : m.records_body_restore_latest()}
                  </Button>
                ) : null}
                {!suggestionFrozen ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      color="primary"
                      className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                      isDisabled={busy}
                      onPress={() => void confirmSuggestion(message.id, suggestion)}
                    >
                      {suggestion.type === "key-point-edit"
                        ? m.records_key_points_insert()
                        : m.records_assistant_confirm_write()}
                    </Button>
                    <Button
                      size="sm"
                      color="tertiary"
                      isDisabled={busy}
                      onPress={() => void onIgnoreSuggestion(message.id, suggestion)}
                    >
                      {m.records_assistant_ignore_suggestion()}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </>
  );
});
