import type { ReactNode } from "react";
import { XClose as X } from "@untitledui/icons";

import { BadgeWithButton } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { ActorName } from "#src/features/avatars/actor-name";
import { PickerMenu, type PickerOption } from "#src/features/pickers/entity-picker";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { memberLabel, type TemplateMemberOption } from "./weekly-template-members";

export function OutlineRow({
  label,
  value,
  onChange,
  onRemove,
  removeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-sm text-tertiary">{label}</span>
      <Input className="min-w-0 flex-1" value={value} onChange={onChange} />
      <ButtonUtility
        size="sm"
        color="tertiary"
        icon={X}
        aria-label={removeLabel}
        onClick={onRemove}
      />
    </div>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-secondary">{label}</span>
      {children}
    </div>
  );
}

export function TemplateRecipientsField({
  allMembers,
  recipientIds,
  members,
  recipientLabel,
  recipientOptions,
  selectedRecipientKeys,
  onClearAll,
  onToggleRecipient,
  onRecipientSelectionChange,
}: {
  allMembers: boolean;
  recipientIds: string[];
  members: TemplateMemberOption[];
  recipientLabel: string;
  recipientOptions: PickerOption[];
  selectedRecipientKeys: string[];
  onClearAll: () => void;
  onToggleRecipient: (userId: string) => void;
  onRecipientSelectionChange: (ids: string[]) => void;
}) {
  return (
    <Field label={m.records_template_recipients()}>
      <div className="space-y-2">
        {allMembers || recipientIds.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {allMembers ? (
              <BadgeWithButton
                size="sm"
                color="gray"
                type="modern"
                buttonLabel={m.records_template_remove_recipient({
                  name: m.records_template_all_members(),
                })}
                onButtonClick={onClearAll}
              >
                {m.records_template_all_members()}
              </BadgeWithButton>
            ) : (
              recipientIds.map((id) => {
                const member = members.find((row) => row.userId === id);
                const name = memberLabel(member ?? { username: id, displayName: null });
                return (
                  <BadgeWithButton
                    key={id}
                    size="sm"
                    color="gray"
                    type="modern"
                    buttonLabel={m.records_template_remove_recipient({ name })}
                    onButtonClick={() => onToggleRecipient(id)}
                  >
                    {member ? (
                      <ActorName
                        actor={{
                          kind: "user",
                          id,
                          name: humanLabel(member),
                          avatarUrl: member.avatarUrl,
                        }}
                      />
                    ) : (
                      id
                    )}
                  </BadgeWithButton>
                );
              })
            )}
          </div>
        ) : null}
        <Dropdown.Root>
          <Button type="button" color="secondary" className="w-full justify-start font-normal">
            <span className={recipientLabel ? "truncate" : "truncate text-placeholder"}>
              {recipientLabel || m.records_template_recipients_placeholder()}
            </span>
          </Button>
          <Dropdown.Popover placement="bottom start" className="w-80">
            <PickerMenu
              label={m.records_template_recipients_title()}
              options={recipientOptions}
              selectedKeys={selectedRecipientKeys}
              onSelectedKeysChange={onRecipientSelectionChange}
            />
          </Dropdown.Popover>
        </Dropdown.Root>
      </div>
    </Field>
  );
}
