import {
  CheckCircle,
  DotsHorizontal,
  Download01 as Download,
  Heart,
  MessageChatCircle as Message,
  Trash01 as Trash,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { m } from "#src/paraglide/messages";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import { formatWeeklyReportCompletedAt, type ReportBodyRestoreView } from "./records-content";
import { BackToRecords, RecordsKeyPointReturnBack } from "./records-layout";
import type { ReportSubject } from "./record-subject";

export function ReportDetailHeader({
  report,
  returnTo,
  editable,
  isAssignment,
  restoreView,
  restoreBusy,
  onSwitchBodyVersion,
  sendAck,
  sent,
  assignmentUnchanged,
  onSubmit,
  favorited,
  favoriteBusy,
  onToggleFavorite,
  sideOpen,
  onOpenSide,
  saving,
  onExport,
  onRequestDelete,
}: {
  report: ReportSubject["report"];
  returnTo?: string;
  editable: boolean;
  isAssignment: boolean;
  restoreView: ReportBodyRestoreView | null;
  restoreBusy: boolean;
  onSwitchBodyVersion: () => void;
  sendAck: boolean;
  sent: boolean;
  assignmentUnchanged: boolean;
  onSubmit: () => void;
  favorited: boolean;
  favoriteBusy: boolean;
  onToggleFavorite: () => void;
  sideOpen: boolean;
  onOpenSide: () => void;
  saving: boolean;
  onExport: () => void;
  onRequestDelete: () => void;
}) {
  return (
    <header className="flex shrink-0 items-start gap-3 border-b border-secondary px-4 py-2 sm:px-6">
      <span className="flex shrink-0 items-center gap-1 pt-0.5">
        {returnTo ? <RecordsKeyPointReturnBack returnTo={returnTo} /> : <BackToRecords />}
      </span>
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <IdentityAvatar
          size="sm"
          name={report.author.displayName}
          alt={report.author.displayName}
          src={report.author.avatarUrl}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-primary">{report.title}</h1>
          {report.submittedAt ? (
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1 text-sm text-tertiary">
              <span className="truncate">
                {m.records_report_completed_at({
                  time: formatWeeklyReportCompletedAt(report.submittedAt),
                })}
              </span>
              <span className="truncate">
                {m.records_report_shared_by({
                  name: report.sharedBy?.displayName ?? report.author.displayName,
                })}
              </span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 pt-0.5">
        {editable && restoreView ? (
          <Button
            size="sm"
            color="secondary"
            isDisabled={restoreBusy}
            isLoading={restoreBusy}
            onPress={onSwitchBodyVersion}
          >
            {restoreView.showing === "latest"
              ? m.records_body_restore_previous()
              : m.records_body_restore_latest()}
          </Button>
        ) : null}
        {editable && isAssignment ? (
          <>
            {sendAck ? (
              <span
                role="status"
                className="inline-flex items-center gap-1 text-sm font-medium text-success-primary duration-200 animate-in fade-in"
              >
                <CheckCircle aria-hidden="true" className="size-4" />
                {m.records_report_send_succeeded()}
              </span>
            ) : null}
            <Button
              size="sm"
              color="primary"
              className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
              preventFocusOnPress
              isDisabled={assignmentUnchanged}
              onPress={onSubmit}
            >
              {sent ? m.records_report_resend() : m.records_report_send()}
            </Button>
          </>
        ) : null}
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={Heart}
          aria-label={favorited ? m.records_report_unfavorite() : m.records_report_favorite()}
          aria-pressed={favorited}
          isDisabled={favoriteBusy}
          className={favorited ? "text-brand-secondary" : undefined}
          onClick={onToggleFavorite}
        />
        {sideOpen ? null : (
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Message}
            aria-label={m.records_side_chat()}
            onClick={onOpenSide}
          />
        )}
        <Dropdown.Root>
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={DotsHorizontal}
            aria-label={m.records_report_actions()}
            isDisabled={saving || favoriteBusy}
          />
          <Dropdown.Popover placement="bottom end" className="w-44">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === "favorite") onToggleFavorite();
                if (key === "export") onExport();
                if (key === "delete") onRequestDelete();
              }}
            >
              <Dropdown.Item id="export" icon={Download} label={m.records_report_export()} />
              {editable ? (
                <Dropdown.Item id="delete" icon={Trash} label={m.records_report_delete()} />
              ) : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      </div>
    </header>
  );
}
