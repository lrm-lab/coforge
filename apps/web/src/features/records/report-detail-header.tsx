import {
  CheckCircle,
  DotsHorizontal,
  Download01 as Download,
  Heart,
  Trash01 as Trash,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { m } from "#src/paraglide/messages";
import { SideChatIcon } from "./side-chat-icon";
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
    <>
      <header className="h-12 shrink-0 border-b border-secondary">
        <div className="mx-auto flex h-full w-full max-w-4xl items-center gap-3 px-4 sm:px-8">
          {returnTo ? (
            <span className="flex shrink-0 items-center gap-1">
              <RecordsKeyPointReturnBack returnTo={returnTo} />
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1 lg:hidden">
              <BackToRecords />
            </span>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <ActorAvatar
              presence={false}
              size="sm"
              name={report.author.displayName}
              alt=""
              src={report.author.avatarUrl}
            />
            <h1 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">
              <bdi>{report.title}</bdi>
            </h1>
          </div>
          <div className="ms-auto flex shrink-0 items-center gap-1">
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
                    className="inline-flex items-center gap-1 text-sm font-medium text-success-primary motion-enter-strong animate-in fade-in"
                  >
                    <CheckCircle aria-hidden="true" className="size-4" />
                    {m.records_report_send_succeeded()}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  color="primary"
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
                icon={SideChatIcon}
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
                    <>
                      <Dropdown.Separator />
                      <Dropdown.Item
                        id="delete"
                        icon={Trash}
                        label={m.records_report_delete()}
                        tone="destructive"
                      />
                    </>
                  ) : null}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          </div>
        </div>
      </header>
      {report.submittedAt ? (
        <p className="mx-auto flex w-full max-w-4xl min-w-0 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 px-4 pt-2 text-sm text-tertiary sm:px-8">
          <span className="min-w-0 wrap-anywhere">
            {m.records_report_completed_at({
              time: formatWeeklyReportCompletedAt(report.submittedAt),
            })}
          </span>
          <span className="min-w-0 wrap-anywhere">
            {messageSlots(m.records_report_shared_by, {
              name: (
                <ActorName
                  actor={{
                    kind: "user",
                    id: (report.sharedBy ?? report.author).userId,
                    name: (report.sharedBy ?? report.author).displayName,
                    avatarUrl: (report.sharedBy ?? report.author).avatarUrl,
                  }}
                />
              ),
            })}
          </span>
        </p>
      ) : null}
    </>
  );
}
