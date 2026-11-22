import { DotsHorizontal, Trash01 as Trash } from "@untitledui/icons";

import { SideChatIcon } from "./side-chat-icon";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
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
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 py-2 sm:px-6">
      <span className="flex shrink-0 items-center gap-2">
        {returnTo ? <RecordsKeyPointReturnBack returnTo={returnTo} /> : <BackToRecords />}
        <WeekBadge week={week} />
      </span>
      {isOverview ? (
        <h1 className="min-w-0 flex-1 text-md font-semibold wrap-anywhere text-primary sm:text-lg">
          {title}
        </h1>
      ) : (
        <input
          type="text"
          aria-label={m.records_template_name()}
          value={titleDraft}
          disabled={saving || sending}
          aria-invalid={titleError !== null}
          aria-describedby={titleError ? "report-title-error" : undefined}
          onChange={(event) => onTitleDraftChange(event.target.value)}
          className="min-w-0 flex-1 truncate bg-transparent text-md font-semibold text-primary outline-none placeholder:text-tertiary focus-visible:outline-none disabled:opacity-60 sm:text-lg"
        />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {isOverview ? null : (
          <>
            <Button
              size="sm"
              color="primary"
              className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
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
                  <Dropdown.Item id="delete" icon={Trash} label={m.records_week_delete()} />
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
                <Dropdown.Item id="reset" icon={Trash} label={m.records_report_reset()} />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        )}
      </div>
    </header>
  );
}
