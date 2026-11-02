import { humanLabel } from "#src/lib/human-label";
import { useEffectEvent, useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { BadgeWithButton } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Select } from "#src/components/base/select/select";
import { PickerMenu, type PickerOption } from "#src/features/pickers/entity-picker";
import { m } from "#src/paraglide/messages";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import { isValidTemplateName, hourlySendTimes } from "./records-content";
import {
  FOUNDATION_MODELS_WEEKLY_SECTIONS,
  FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME,
} from "./foundation-models-weekly";
import { parseTemplateSections, type TemplateOutlineSection } from "./template-outline-sections";
import { memberLabel, weekdayLabel, type TemplateMemberOption } from "./weekly-template-members";
import type { WeeklyTemplateList } from "./weekly-report-settings";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";
import { Field, OutlineRow } from "./weekly-template-fields";

const SEND_TIMES = hourlySendTimes();
const SEND_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function emptySection(): TemplateOutlineSection {
  return { title: "", children: [] };
}

function foundationModelsSections(): TemplateOutlineSection[] {
  return FOUNDATION_MODELS_WEEKLY_SECTIONS.map((section) => ({
    ...section,
    children: [...section.children],
  }));
}

export type CreateWeeklyTemplateInput = {
  name: string;
  frequency: "weekly";
  sendTime: string;
  sendWeekday: number;
  scheduleEnabled: boolean;
  sections: TemplateOutlineSection[];
  allMembers: boolean;
  recipientUserIds: string[];
};

export type WeeklyTemplateDraft = WeeklyTemplateList[number];

export function CreateWeeklyTemplateDialog({
  open,
  onOpenChange,
  onSave,
  members,
  initial = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (template: CreateWeeklyTemplateInput) => void | Promise<void>;
  members: TemplateMemberOption[];
  initial?: WeeklyTemplateDraft | null;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME);
  const [sections, setSections] = useState<TemplateOutlineSection[]>(foundationModelsSections);
  const [allMembers, setAllMembers] = useState(true);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [frequency] = useState<"weekly">("weekly");
  const [sendTime, setSendTime] = useState<string>("15:00");
  const [sendWeekday, setSendWeekday] = useState(5);
  const [enabled, setEnabled] = useState(true);
  const [nameError, setNameError] = useState(false);
  const [saving, setSaving] = useState(false);

  // Everyone first, then each person, searched by name, username and role too.
  const recipientOptions = useMemo(
    (): PickerOption[] => [
      { id: "all", label: m.records_template_all_members() },
      ...members.map((member) => ({
        id: member.userId,
        label: memberLabel(member),
        face: { kind: "identity" as const, name: humanLabel(member), src: member.avatarUrl },
        keywords: [member.username, member.role].filter(Boolean).join(" "),
      })),
    ],
    [members],
  );

  function reset() {
    setName(FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME);
    setSections(foundationModelsSections());
    setAllMembers(true);
    setRecipientIds([]);
    setSendTime("15:00");
    setSendWeekday(5);
    setEnabled(true);
    setNameError(false);
    setSaving(false);
  }

  function applyInitial(template: WeeklyTemplateDraft | null | undefined) {
    if (!template) {
      reset();
      return;
    }
    setName(template.name);
    const parsed = parseTemplateSections(template.sections ?? template.dimensions);
    setSections(parsed.length > 0 ? parsed : [emptySection()]);
    setAllMembers(template.allMembers);
    setRecipientIds(template.allMembers ? [] : template.recipients.map((row) => row.userId));
    setSendTime(template.sendTime || "15:00");
    setSendWeekday(template.sendWeekday || 5);
    setEnabled(Boolean(template.active));
    setNameError(false);
    setSaving(false);
  }

  const resetDraft = useEffectEvent(() => applyInitial(initial));
  const initialId = initial?.id;
  useLayoutEffect(() => {
    if (open) resetDraft();
  }, [open, initialId]);

  function updateSectionTitle(index: number, title: string) {
    setSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, title } : section,
      ),
    );
  }

  function updateChildTitle(sectionIndex: number, childIndex: number, title: string) {
    setSections((current) =>
      current.map((section, index) => {
        if (index !== sectionIndex) return section;
        return {
          ...section,
          children: section.children.map((child, offset) =>
            offset === childIndex ? title : child,
          ),
        };
      }),
    );
  }

  function addSection() {
    setSections((current) => [...current, emptySection()]);
  }

  function removeSection(index: number) {
    setSections((current) => {
      const next = current.filter((_, sectionIndex) => sectionIndex !== index);
      return next.length > 0 ? next : [emptySection()];
    });
  }

  function addChild(sectionIndex: number) {
    setSections((current) =>
      current.map((section, index) =>
        index === sectionIndex ? { ...section, children: [...section.children, ""] } : section,
      ),
    );
  }

  function removeChild(sectionIndex: number, childIndex: number) {
    setSections((current) =>
      current.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              children: section.children.filter((_, offset) => offset !== childIndex),
            }
          : section,
      ),
    );
  }

  const selectedRecipientKeys = allMembers
    ? ["all", ...members.map((member) => member.userId)]
    : recipientIds;

  function toggleRecipient(userId: string | "all") {
    if (userId === "all") {
      setAllMembers((current) => !current);
      setRecipientIds([]);
      return;
    }
    if (allMembers) {
      setAllMembers(false);
      setRecipientIds(members.map((member) => member.userId).filter((id) => id !== userId));
      return;
    }
    const next = recipientIds.includes(userId)
      ? recipientIds.filter((id) => id !== userId)
      : [...recipientIds, userId];
    if (members.length > 0 && members.every((member) => next.includes(member.userId))) {
      setAllMembers(true);
      setRecipientIds([]);
      return;
    }
    setAllMembers(false);
    setRecipientIds(next);
  }

  /** The one recipient a tick or untick changed. */
  function onRecipientSelectionChange(ids: string[]) {
    const changed =
      ids.find((id) => !selectedRecipientKeys.includes(id)) ??
      selectedRecipientKeys.find((id) => !ids.includes(id));
    if (changed !== undefined) toggleRecipient(changed);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidTemplateName(name)) {
      setNameError(true);
      return;
    }
    const normalizedSections = sections
      .map((section) => ({
        title: section.title.trim(),
        children: section.children.map((child) => child.trim()).filter(Boolean),
      }))
      .filter((section) => section.title.length > 0);
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        frequency,
        sendTime,
        sendWeekday,
        scheduleEnabled: enabled,
        sections: normalizedSections,
        allMembers: allMembers || recipientIds.length === 0,
        recipientUserIds: allMembers ? [] : recipientIds,
      });
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  const recipientLabel = (() => {
    if (allMembers) return m.records_template_all_members();
    if (recipientIds.length === 0) return "";
    return recipientIds
      .map((id) => {
        const member = members.find((row) => row.userId === id);
        return member && humanLabel(member);
      })
      .filter(Boolean)
      .join(", ");
  })();

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-xl">
        <Dialog>
          {({ close }) => (
            <>
              <div className="flex items-start justify-between gap-6 px-6 pt-6">
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {editing ? m.records_edit_template() : m.records_create_template()}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  isDisabled={saving}
                  onClick={close}
                />
              </div>

              <form onSubmit={(event) => void submit(event)}>
                <div className="max-h-[min(70vh,36rem)] space-y-5 overflow-y-auto px-6 py-5">
                  <p className="text-sm font-semibold text-primary">
                    {m.records_template_details()}
                  </p>

                  <Input
                    label={m.records_template_name()}
                    value={name}
                    hideRequiredIndicator
                    onChange={(value) => {
                      setName(value);
                      setNameError(value.trim().length > 0 && !isValidTemplateName(value));
                    }}
                    placeholder={m.records_template_name_placeholder()}
                    isInvalid={nameError}
                    hint={m.records_template_name_hint()}
                  />

                  <div className="space-y-3">
                    {sections.map((section, sectionIndex) => (
                      <div key={sectionIndex} className="space-y-2">
                        <OutlineRow
                          label={m.records_template_heading_level_one()}
                          value={section.title}
                          onChange={(value) => updateSectionTitle(sectionIndex, value)}
                          onRemove={() => removeSection(sectionIndex)}
                          removeLabel={m.records_template_delete_heading()}
                        />
                        {section.children.length > 0 ? (
                          <div className="relative ml-3 space-y-2 border-l-2 border-secondary pl-4">
                            {section.children.map((child, childIndex) => (
                              <OutlineRow
                                key={`${sectionIndex}-${childIndex}`}
                                label={m.records_template_heading_level_two()}
                                value={child}
                                onChange={(value) =>
                                  updateChildTitle(sectionIndex, childIndex, value)
                                }
                                onRemove={() => removeChild(sectionIndex, childIndex)}
                                removeLabel={m.records_template_delete_heading()}
                              />
                            ))}
                          </div>
                        ) : null}
                        <div className="pl-1">
                          <Button
                            type="button"
                            size="sm"
                            color="link-gray"
                            onPress={() => addChild(sectionIndex)}
                          >
                            {m.records_template_add_heading_level_two()}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button type="button" size="sm" color="secondary" onPress={addSection}>
                      {m.records_template_add_heading_level_one()}
                    </Button>
                  </div>

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
                              onButtonClick={() => {
                                setAllMembers(false);
                                setRecipientIds([]);
                              }}
                            >
                              {m.records_template_all_members()}
                            </BadgeWithButton>
                          ) : (
                            recipientIds.map((id) => {
                              const member = members.find((row) => row.userId === id);
                              const name = memberLabel(
                                member ?? { username: id, displayName: null },
                              );
                              return (
                                <BadgeWithButton
                                  key={id}
                                  size="sm"
                                  color="gray"
                                  type="modern"
                                  buttonLabel={m.records_template_remove_recipient({ name })}
                                  onButtonClick={() => toggleRecipient(id)}
                                >
                                  {member ? humanLabel(member) : id}
                                </BadgeWithButton>
                              );
                            })
                          )}
                        </div>
                      ) : null}
                      <Dropdown.Root>
                        <Button
                          type="button"
                          color="secondary"
                          className="w-full justify-start font-normal"
                        >
                          <span
                            className={recipientLabel ? "truncate" : "truncate text-placeholder"}
                          >
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

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Select
                      label={m.records_template_frequency()}
                      size="sm"
                      selectedKey={frequency}
                      onSelectionChange={() => {}}
                      hideRequiredIndicator
                    >
                      <Select.Item id="weekly" label={m.records_template_frequency_weekly()} />
                    </Select>
                    <Select
                      label={m.records_template_send_weekday()}
                      size="sm"
                      selectedKey={String(sendWeekday)}
                      onSelectionChange={(key) => setSendWeekday(key ? Number(key) : 5)}
                      hideRequiredIndicator
                    >
                      {SEND_WEEKDAYS.map((day) => (
                        <Select.Item key={day} id={String(day)} label={weekdayLabel(day)} />
                      ))}
                    </Select>
                  </div>

                  <Select
                    label={m.records_template_send_time()}
                    size="sm"
                    selectedKey={sendTime}
                    onSelectionChange={(key) => setSendTime(key ? String(key) : "15:00")}
                    hideRequiredIndicator
                  >
                    {SEND_TIMES.map((time) => (
                      <Select.Item key={time} id={time} label={time} />
                    ))}
                  </Select>

                  <Select
                    label={m.records_template_enabled()}
                    size="sm"
                    selectedKey={enabled ? "yes" : "no"}
                    onSelectionChange={(key) => setEnabled(key !== "no")}
                    hideRequiredIndicator
                  >
                    <Select.Item id="yes" label={m.records_template_enabled_yes()} />
                    <Select.Item id="no" label={m.records_template_enabled_no()} />
                  </Select>
                </div>

                <DialogActions className="px-6 pt-4 pb-6">
                  <DialogCancel
                    type="button"
                    isDisabled={saving}
                    onPress={() => {
                      reset();
                      onOpenChange(false);
                    }}
                  >
                    {m.records_template_cancel()}
                  </DialogCancel>
                  <DialogAction
                    type="submit"
                    className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                    isDisabled={saving}
                  >
                    {m.records_template_save()}
                  </DialogAction>
                </DialogActions>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
