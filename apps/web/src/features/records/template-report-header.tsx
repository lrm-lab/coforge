import { DotsHorizontal, Trash01 as Trash } from "@untitledui/icons";

import { SideChatIcon } from "./side-chat-icon";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { PANE_HEADER_ATTR, PANE_HEADER_CLASS } from "#src/components/layout/pane-header";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { BackToRecords, RecordsKeyPointReturnBack } from "./records-layout";
import { WeekBadge } from "./records-sidebar-parts";

export function TemplateReportHeader({
  week,
  title,
  returnTo,
  isOverview,
  isOverviewLeader,
  titleDraft,
  titleError,
  onTitleDraftChange,
  saving,
  sending,
  hasUnsavedEdits,
  alreadySent,
  canSendAssignments,
  weekDismissed,
  onOpenConfirmSend,
  onSaveFormatEdits,
  sideOpen,
  onOpenSide,
  onRequestDeleteOverview,
  onResetPage,
}: {
  week: number;
  title: string;
  returnTo?: string;
  isOverview: boolean;
  isOverviewLeader: boolean;
  titleDraft: string;
  titleError: string | null;
  onTitleDraftChange: (value: string) => void;
  saving: boolean;
  sending: boolean;
  hasUnsavedEdits: boolean;
  alreadySent: boolean;
  canSendAssignments: boolean;
  weekDismissed: boolean;
  onOpenConfirmSend: () => void;
  onSaveFormatEdits: () => void;
  sideOpen: boolean;
  onOpenSide: () => void;
  onRequestDeleteOverview: () => void;
  onResetPage: () => void;
}) {
  return (
    <header {...PANE_HEADER_ATTR} className={cx(PANE_HEADER_CLASS, "gap-3 px-4 sm:px-6")}>
      <span className="flex shrink-0 items-center gap-2">
        {returnTo ? <RecordsKeyPointReturnBack returnTo={returnTo} /> : <BackToRecords />}
        <WeekBadge week={week} />
      </span>
      {isOverview ? (
        <h1 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">
          <bdi>{title}</bdi>
        </h1>
      ) : (
        <Input
          type="text"
          maxLength={100}
          aria-label={m.records_template_name()}
          aria-describedby={titleError ? "report-title-error" : undefined}
          value={titleDraft}
          isDisabled={saving || sending}
          isInvalid={titleError !== null}
          onChange={onTitleDraftChange}
          className="min-w-0 flex-1"
          wrapperClassName="rounded-sm bg-transparent shadow-none ring-0 disabled:bg-transparent disabled:opacity-60"
          inputClassName="truncate px-0 py-0 pr-0 text-md font-semibold text-primary"
          tooltipClassName="hidden group-invalid/input:hidden"
        />
      )}
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {isOverview ? null : (
          <>
            <Button
              size="sm"
              color="primary"
              isDisabled={
                saving ||
                sending ||
                hasUnsavedEdits ||
                alreadySent ||
                (!canSendAssignments && !weekDismissed)
              }
              onPress={onOpenConfirmSend}
            >
              {m.records_report_send()}
            </Button>
            {hasUnsavedEdits ? (
              <Button
                size="sm"
                color="secondary"
                isDisabled={saving || sending}
                onPress={onSaveFormatEdits}
              >
                {m.records_report_save()}
              </Button>
            ) : null}
          </>
        )}
        {sideOpen ? null : (
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={SideChatIcon}
            aria-label={m.records_side_chat()}
            onClick={onOpenSide}
          />
        )}
        {isOverview ? (
          isOverviewLeader ? (
            <Dropdown.Root>
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.records_report_actions()}
                isDisabled={saving || sending}
              />
              <Dropdown.Popover placement="bottom end" className="w-44">
                <Dropdown.Menu onAction={onRequestDeleteOverview}>
                  <Dropdown.Item
                    id="delete"
                    icon={Trash}
                    label={m.records_week_delete()}
                    tone="destructive"
                  />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          ) : null
        ) : (
          <Dropdown.Root>
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={DotsHorizontal}
              aria-label={m.records_report_actions()}
              isDisabled={saving || sending}
            />
            <Dropdown.Popover placement="bottom end" className="w-44">
              <Dropdown.Menu onAction={onResetPage}>
                <Dropdown.Item
                  id="reset"
                  icon={Trash}
                  label={m.records_report_reset()}
                  tone="destructive"
                />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        )}
      </div>
    </header>
  );
}
