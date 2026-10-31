import { CheckCircle, Link01 as LinkIcon } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import type { RecordAssistantPayload } from "./weekly-highlight-extract";
import { formatWeeklyReportCompletedAt } from "./records-content";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";

// The cards the Record side chat shows in its timeline: a week's send offer and its actions.

export function FormatSendActions({
  disabled,
  onSend,
  onCancel,
}: {
  disabled: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        color="primary"
        className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
        isDisabled={disabled}
        onPress={onSend}
      >
        {m.records_assistant_confirm_send()}
      </Button>
      <Button size="sm" color="secondary" isDisabled={disabled} onPress={onCancel}>
        {m.records_assistant_cancel_week()}
      </Button>
    </div>
  );
}

export function AssistantAttachmentCard({
  payload,
  disabled,
  onOpen,
}: {
  payload: Extract<RecordAssistantPayload, { kind: "offer-send" }>;
  disabled: boolean;
  onOpen: () => void;
}) {
  const title =
    payload.weekTitle?.trim() ||
    (payload.year != null && payload.week != null
      ? `${payload.year} W${payload.week}`
      : m.records_assistant_template());
  const updatedLabel = payload.updatedAt
    ? m.records_assistant_template_updated({
        time: formatWeeklyReportCompletedAt(payload.updatedAt).replace(/:\d{2}$/, ""),
      })
    : m.records_assistant_template_ready();
  const recipients = payload.recipients ?? [];
  const shown = recipients.slice(0, 5);
  const overflow =
    typeof payload.recipientTotal === "number"
      ? Math.max(0, payload.recipientTotal - shown.length)
      : Math.max(0, recipients.length - shown.length);

  return (
    <Button
      size="sm"
      color="tertiary"
      noTextPadding
      isDisabled={disabled}
      aria-label={`${m.records_template_open_detail()}: ${title}`}
      onPress={onOpen}
      className="h-auto w-full items-start justify-start whitespace-normal rounded-xl bg-gradient-to-br from-secondary via-secondary/40 to-primary p-3 text-left font-normal hover:bg-primary_hover"
    >
      <div className="flex w-full items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tertiary text-fg-secondary">
          <LinkIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-primary">{title}</p>
          <p className="text-xs text-tertiary">{m.records_assistant_template()}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-tertiary">
            <CheckCircle className="size-3.5 text-success-primary" />
            <span>{updatedLabel}</span>
          </p>
          {shown.length > 0 ? (
            <div className="mt-2 flex items-center">
              {shown.map((person, index) => (
                <IdentityAvatar
                  key={`${person.displayName}-${index}`}
                  size="xs"
                  name={person.displayName}
                  alt={person.displayName}
                  userId={person.userId}
                  src={person.avatarUrl}
                  className={cx("ring-2 ring-primary", index > 0 ? "-ml-1.5" : undefined)}
                />
              ))}
              {overflow > 0 ? (
                <span className="ml-1.5 text-xs font-medium text-tertiary">
                  {m.records_assistant_recipients_overflow({ count: overflow })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Button>
  );
}
