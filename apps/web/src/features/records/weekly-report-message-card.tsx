import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useRouter } from "@tanstack/react-router";
import { m } from "#src/paraglide/messages";
import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import { isAppError } from "#src/lib/app-error";
import {
  applyConfirmedWeeklyReportBody,
  confirmWeeklyReportSend,
  dismissWeeklyFormatSend,
  switchWeeklyReportBodyVersion,
} from "./records.functions";
import type { ReportBodyRestoreView } from "./records-content";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import { WeeklySendConfirmDialog } from "./weekly-send-confirm-dialog";
import { WeeklyReportCollectPlanCard } from "./weekly-report-collect-plan-card";
import { WeeklyReportCollectRunCard } from "./weekly-report-collect-run-card";
import {
  readCollectCardRunId,
  writeCollectCardRunId,
  readAppliedSuggestionIds,
  writeAppliedSuggestionIds,
} from "./weekly-report-assistant-session";

export type WeeklyReportMessageSuggestion = Extract<
  WeeklyReportAssistantSuggestion,
  { type: "collect-plan" | "body-edit" | "send-prompt" }
>;

export function WeeklyReportMessageCard(props: {
  messageId: string;
  suggestion: WeeklyReportMessageSuggestion;
  onOpenAgentProfile?: OpenAgentProfile;
  disabled?: boolean;
}) {
  const { suggestion } = props;
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const cardKey = `${workspaceSlug}:${props.messageId}`;
  const applyBody = useServerFn(applyConfirmedWeeklyReportBody);
  const switchBody = useServerFn(switchWeeklyReportBodyVersion);
  const confirmSendPrompt = useServerFn(confirmWeeklyReportSend);
  const dismissWeek = useServerFn(dismissWeeklyFormatSend);
  const [runId, setRunId] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [restoreView, setRestoreView] = useState<ReportBodyRestoreView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    setRunId(readCollectCardRunId(cardKey));
    setApplied(readAppliedSuggestionIds(cardKey).includes(props.messageId));
    setLoaded(true);
  }, [cardKey, props.messageId]);

  function onSubmitted(id: string) {
    writeCollectCardRunId(cardKey, id);
    setRunId(id);
  }

  async function insertDraft() {
    if (suggestion.type !== "body-edit" || busy || applied || props.disabled) return;
    setBusy(true);
    setError(null);
    try {
      const written = await applyBody({
        data: {
          reportId: suggestion.reportId,
          content: suggestion.content,
          sourceMessageId: props.messageId,
        },
      });
      setRestoreView(written.bodyRestoreView);
      setApplied(true);
      writeAppliedSuggestionIds(cardKey, [props.messageId]);
      await router.invalidate({ sync: true });
    } catch {
      setError(m.records_assistant_write_failed());
    } finally {
      setBusy(false);
    }
  }

  async function switchVersion() {
    if (suggestion.type !== "body-edit" || busy || props.disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await switchBody({ data: { reportId: suggestion.reportId } });
      setRestoreView(result.bodyRestoreView);
      await router.invalidate({ sync: true });
    } catch {
      setError(m.records_assistant_write_failed());
    } finally {
      setBusy(false);
    }
  }

  async function confirmSend() {
    if (suggestion.type !== "send-prompt" || busy || applied || props.disabled) return;
    setBusy(true);
    setError(null);
    try {
      await confirmSendPrompt({ data: { reportId: suggestion.reportId } });
      setApplied(true);
      writeAppliedSuggestionIds(cardKey, [props.messageId]);
      setConfirmOpen(false);
      await router.invalidate({ sync: true });
    } catch (cause) {
      setError(weeklySendError(cause));
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function cancelWeek() {
    if (suggestion.type !== "send-prompt" || busy || cancelled || props.disabled) return;
    setBusy(true);
    setError(null);
    try {
      await dismissWeek({ data: { reportId: suggestion.reportId } });
      setCancelled(true);
      await router.invalidate({ sync: true });
    } catch {
      setError(m.records_assistant_write_failed());
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-tertiary">{m.records_collect_run_loading()}</p>;

  if (suggestion.type === "send-prompt") {
    return (
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            color="primary"
            className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
            isDisabled={busy || applied || props.disabled}
            isLoading={busy && !confirmOpen}
            onPress={() => setConfirmOpen(true)}
          >
            {m.records_assistant_confirm_send()}
          </Button>
          <Button
            size="sm"
            color="secondary"
            isDisabled={busy || cancelled || props.disabled}
            onPress={() => void cancelWeek()}
          >
            {m.records_assistant_cancel_week()}
          </Button>
        </div>
        {error ? <p className="text-sm text-error-primary">{error}</p> : null}
        <WeeklySendConfirmDialog
          open={confirmOpen}
          busy={busy}
          onOpenChange={setConfirmOpen}
          onConfirm={() => void confirmSend()}
        />
        <ReportLink workspaceSlug={workspaceSlug} reportId={suggestion.reportId} />
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {suggestion.type === "collect-plan" ? (
        runId ? (
          <WeeklyReportCollectRunCard runId={runId} />
        ) : (
          <WeeklyReportCollectPlanCard
            storageKey={props.messageId}
            reportId={suggestion.reportId}
            year={suggestion.year}
            week={suggestion.week}
            disabled={props.disabled}
            onOpenAgentProfile={props.onOpenAgentProfile}
            onSubmitted={onSubmitted}
          />
        )
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm text-secondary">
            {Object.entries(suggestion.content.tabs ?? {})
              .map(([name, tab]) => `${name}\n${tab.markdown}`)
              .join("\n\n") || suggestion.content.markdown}
          </p>
          {restoreView?.sourceMessageId === props.messageId ? (
            <Button
              size="sm"
              color="secondary"
              isDisabled={busy || props.disabled}
              isLoading={busy}
              onPress={() => void switchVersion()}
            >
              {restoreView.showing === "latest"
                ? m.records_body_restore_previous()
                : m.records_body_restore_latest()}
            </Button>
          ) : (
            <Button
              size="sm"
              color="secondary"
              isDisabled={busy || applied || props.disabled}
              isLoading={busy}
              onPress={() => void insertDraft()}
            >
              {m.records_assistant_confirm_write()}
            </Button>
          )}
          {error ? <p className="text-sm text-error-primary">{error}</p> : null}
        </>
      )}
      <ReportLink workspaceSlug={workspaceSlug} reportId={suggestion.reportId} />
    </div>
  );
}

function ReportLink(props: { workspaceSlug: string; reportId: string }) {
  return (
    <Link
      to="/w/$workspaceSlug/records/$recordId"
      params={{ workspaceSlug: props.workspaceSlug, recordId: props.reportId }}
      search={{ tab: "weekly" }}
      className="text-sm text-brand-secondary"
    >
      {m.records_title()}
    </Link>
  );
}

function weeklySendError(cause: unknown): string {
  const nested =
    cause && typeof cause === "object" && "cause" in cause
      ? (cause as { cause: unknown }).cause
      : cause;
  const appError = isAppError(nested) ? nested : isAppError(cause) ? cause : null;
  if (appError?.errorId === "weekly-send-no-settings") return m.records_report_send_no_settings();
  if (appError?.errorId === "weekly-send-no-recipients")
    return m.records_report_send_no_recipients();
  return m.records_report_send_assignments_error();
}
