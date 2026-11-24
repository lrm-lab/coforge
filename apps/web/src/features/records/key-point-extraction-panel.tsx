import { AlertCircle, RefreshCcw01 as Refresh } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { KeyPointExtractionMeta } from "./records-content";
import { ReportSectionEditor } from "#src/features/records/report-editor/report-section-editor";
import { RecordsReadingColumn } from "./records-reading-column";

export const KEY_POINT_EXTRACTION_TAB = "key_points";

export function KeyPointExtractionPanel({
  extraction,
  assistantAgentId,
  restartBusy,
  onRestart,
  waitingLabel,
  editPrompt,
  className,
  framed = true,
  scrollable = true,
}: {
  extraction: KeyPointExtractionMeta | undefined;
  assistantAgentId?: string | null;
  restartBusy?: boolean;
  onRestart?: () => void;
  waitingLabel?: string;
  editPrompt?: {
    slot: "personal" | "team";
    returnTo: string;
  };
  className?: string;
  framed?: boolean;
  scrollable?: boolean;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const status = extraction?.status;
  const canRestart =
    Boolean(onRestart) &&
    status !== undefined &&
    status !== "generating" &&
    (status === "ready" ||
      status === "failed" ||
      status === "pending_setup" ||
      status === "awaiting_confirm");
  const showActions = Boolean(editPrompt) || canRestart;

  const body = (
    <>
      {showActions ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {editPrompt ? (
            <Link
              to="/w/$workspaceSlug/records/settings"
              params={{ workspaceSlug }}
              search={{
                tab: "weekly",
                section: "key_points",
                slot: editPrompt.slot,
                returnTo: editPrompt.returnTo,
              }}
              className="text-sm font-medium text-brand-secondary hover:underline"
            >
              {m.records_key_points_edit_prompt()}
            </Link>
          ) : null}
          {canRestart ? (
            <Button
              type="button"
              size="sm"
              color="secondary"
              iconLeading={Refresh}
              isDisabled={restartBusy}
              onPress={() => onRestart?.()}
            >
              {m.records_key_points_restart()}
            </Button>
          ) : null}
        </div>
      ) : null}

      {status === "generating" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_generating()}</p>
      ) : null}
      {status === "awaiting_confirm" ? (
        <p className="text-sm text-tertiary">{m.records_key_points_awaiting_confirm()}</p>
      ) : null}
      {status === "pending_setup" ? (
        <div className="space-y-2 rounded-xl border border-secondary bg-warning-primary p-3">
          <p className="text-sm text-secondary">{m.records_key_points_pending_setup()}</p>
          {assistantAgentId ? (
            <Link
              to="/w/$workspaceSlug/members"
              params={{ workspaceSlug }}
              search={{
                profile: formatAgentProfileParam(assistantAgentId),
                agentTab: "profile",
              }}
              className="text-sm font-semibold text-brand-secondary"
            >
              {m.records_weekly_ai_setup_action()}
            </Link>
          ) : null}
        </div>
      ) : null}
      {status === "failed" && extraction?.error === "no_submitted_member_reports" ? (
        <p className="text-sm text-tertiary">
          {waitingLabel ?? m.records_key_points_waiting_submit()}
        </p>
      ) : null}
      {status === "failed" && extraction?.error !== "no_submitted_member_reports" ? (
        <div className="space-y-2">
          <EmptyState
            size="card"
            role="alert"
            picture={<EmptyIcon icon={AlertCircle} size="card" />}
            title={m.empty_records_key_points_failed_title()}
            primaryAction={
              onRestart ? (
                <RetryButton size="card" isRetrying={restartBusy} onPress={onRestart} />
              ) : undefined
            }
          />
          {extraction?.error?.trim() ? (
            <details className="px-1 text-xs text-tertiary">
              <summary className="cursor-pointer select-none">{m.empty_details_toggle()}</summary>
              <p className="mt-1 font-mono break-words">{extraction.error.trim()}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      {(status === "ready" || status === "generating" || status === "awaiting_confirm") &&
      extraction?.markdown ? (
        <ReportSectionEditor
          key={`${status}:${extraction.markdown.length}:${extraction.markdown.slice(0, 32)}`}
          defaultValue={extraction.markdown}
          editable={false}
          placeholder=""
          onUpdate={() => {}}
        />
      ) : null}
      {status === "ready" && !extraction?.markdown ? (
        <EmptyState size="row" title={m.records_key_points_empty_result()} />
      ) : null}
      {!status ? (
        <EmptyState size="row" title={waitingLabel ?? m.records_key_points_waiting_submit()} />
      ) : null}
    </>
  );

  if (!framed) {
    return <div className={cn("space-y-4", className)}>{body}</div>;
  }

  return (
    <div className={cn(scrollable && "min-h-0 flex-1 overflow-y-auto", className)}>
      <RecordsReadingColumn className="space-y-4">{body}</RecordsReadingColumn>
    </div>
  );
}
