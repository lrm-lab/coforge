import { humanLabel } from "#src/lib/human-label";
import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import { useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@tanstack/react-form";
import { Heading } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { CloseButton } from "#src/components/base/buttons/close-button";
import {
  Dialog as SlideoutDialog,
  Modal as SlideoutModal,
  ModalOverlay as SlideoutOverlay,
  SlideoutMenu,
} from "#src/components/application/slideout-menus/slideout-menu";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { Select } from "#src/components/base/select/select";
import type { PickerOption } from "#src/features/pickers/entity-picker";
import { isAppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { isValidTemplateName, hourlySendTimes } from "./records-content";
import { FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME } from "./foundation-models-weekly";
import { parseTemplateSections, type TemplateOutlineSection } from "./template-outline-sections";
import { memberLabel, weekdayLabel, type TemplateMemberOption } from "./weekly-template-members";
import type { WeeklyTemplateList } from "./weekly-report-settings";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { OutlineRow, TemplateRecipientsField } from "./weekly-template-fields";
import {
  emptySection,
  foundationModelsSections,
  useTemplateOutlineDraft,
} from "./use-template-outline-draft";

const SEND_TIMES = hourlySendTimes();
const SEND_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

type TemplateDraft = {
  name: string;
  sections: TemplateOutlineSection[];
  allMembers: boolean;
  recipientIds: string[];
  sendTime: string;
  sendWeekday: number;
  enabled: boolean;
};

function draftOf(template: WeeklyTemplateDraft | null): TemplateDraft {
  if (!template) {
    return {
      name: FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME,
      sections: foundationModelsSections(),
      allMembers: true,
      recipientIds: [],
      sendTime: "15:00",
      sendWeekday: 5,
      enabled: true,
    };
  }
  const parsed = parseTemplateSections(template.sections ?? template.dimensions);
  return {
    name: template.name,
    sections: parsed.length > 0 ? parsed : [emptySection()],
    allMembers: template.allMembers,
    recipientIds: template.allMembers ? [] : template.recipients.map((row) => row.userId),
    sendTime: template.sendTime || "15:00",
    sendWeekday: template.sendWeekday || 5,
    enabled: Boolean(template.active),
  };
}

function draftKey(draft: TemplateDraft): string {
  return JSON.stringify({ ...draft, recipientIds: [...draft.recipientIds].sort() });
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
  const controlSize = useDialogControlSize();
  const editing = Boolean(initial);
  const {
    sections,
    setSections,
    updateSectionTitle,
    updateChildTitle,
    addSection,
    removeSection,
    addChild,
    removeChild,
  } = useTemplateOutlineDraft();
  const [allMembers, setAllMembers] = useState(true);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const saveOkRef = useRef(false);

  const form = useAppForm({
    defaultValues: {
      name: FOUNDATION_MODELS_WEEKLY_TEMPLATE_NAME,
      frequency: "weekly",
      sendTime: "15:00",
      sendWeekday: "5",
      enabled: "yes",
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const normalizedSections = sections
        .map((section) => ({
          title: section.title.trim(),
          children: section.children.map((child) => child.trim()).filter(Boolean),
        }))
        .filter((section) => section.title.length > 0);
      try {
        await onSave({
          name: value.name.trim(),
          frequency: "weekly",
          sendTime: value.sendTime,
          sendWeekday: Number(value.sendWeekday) || 5,
          scheduleEnabled: value.enabled !== "no",
          sections: normalizedSections,
          allMembers: allMembers || recipientIds.length === 0,
          recipientUserIds: allMembers ? [] : recipientIds,
        });
        saveOkRef.current = true;
      } catch (cause) {
        if (isAppErrorCode(cause, "INVALID_INPUT")) {
          setFieldServerError(form, "name", m.records_template_name_hint(), formRef.current);
        }
      }
    },
  });

  const { name, sendTime, sendWeekday, enabled, saving } = useStore(form.store, (state) => ({
    name: state.values.name,
    sendTime: state.values.sendTime,
    sendWeekday: Number(state.values.sendWeekday) || 5,
    enabled: state.values.enabled !== "no",
    saving: state.isSubmitting,
  }));

  const recipientOptions = useMemo(
    (): PickerOption[] => [
      { id: "all", label: m.records_template_all_members() },
      ...members.map((member) => ({
        id: member.userId,
        label: memberLabel(member),
        face: { kind: "identity" as const, name: humanLabel(member), src: member.avatarUrl },
        keywords: member.role || undefined,
      })),
    ],
    [members],
  );

  function applyInitial(template: WeeklyTemplateDraft | null | undefined) {
    const draft = draftOf(template ?? null);
    form.reset({
      name: draft.name,
      frequency: "weekly",
      sendTime: draft.sendTime,
      sendWeekday: String(draft.sendWeekday),
      enabled: draft.enabled ? "yes" : "no",
    });
    setSections(draft.sections);
    setAllMembers(draft.allMembers);
    setRecipientIds(draft.recipientIds);
  }

  const resetDraft = useEffectEvent(() => applyInitial(initial));
  const initialId = initial?.id;
  useLayoutEffect(() => {
    if (open) resetDraft();
  }, [open, initialId]);

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

  function onRecipientSelectionChange(ids: string[]) {
    const changed =
      ids.find((id) => !selectedRecipientKeys.includes(id)) ??
      selectedRecipientKeys.find((id) => !ids.includes(id));
    if (changed !== undefined) toggleRecipient(changed);
  }

  async function save(): Promise<boolean> {
    saveOkRef.current = false;
    await form.handleSubmit();
    return saveOkRef.current;
  }

  const baseline = useMemo(() => draftKey(draftOf(initial)), [initial]);
  const dirty =
    open &&
    baseline !==
      draftKey({ name, sections, allMembers, recipientIds, sendTime, sendWeekday, enabled });
  const guard = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty,
    close: () => onOpenChange(false),
    onSave: isValidTemplateName(name) ? save : undefined,
  });

  function requestClose() {
    if (!saving) guard.requestClose();
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
    <>
      <SlideoutOverlay
        className={OVERLAY_LAYER}
        isOpen={open}
        isDismissable
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
      >
        <SlideoutModal className="max-w-136">
          <SlideoutDialog
            aria-label={editing ? m.records_edit_template() : m.records_create_template()}
            className="gap-0"
          >
            <header className="relative z-1 w-full border-b border-secondary px-4 pt-6 pb-4 md:px-6">
              <Heading slot="title" className="pe-8 text-md font-semibold text-primary">
                {editing ? m.records_edit_template() : m.records_create_template()}
              </Heading>
              <CloseButton
                size="sm"
                label={m.controls_close()}
                className="absolute end-3 top-3 shrink-0"
              />
            </header>

            <form.AppForm>
              <form
                ref={formRef}
                noValidate
                className="flex min-h-0 w-full flex-1 flex-col"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await save()) onOpenChange(false);
                }}
              >
                <SlideoutMenu.Content role="group" className="min-h-0 flex-1 gap-5 py-5">
                  <p className="text-sm font-semibold text-primary">
                    {m.records_template_details()}
                  </p>

                  <form.AppField
                    name="name"
                    validators={{
                      onChange: ({ value }) =>
                        value.trim().length > 0 && !isValidTemplateName(value)
                          ? m.records_template_name_hint()
                          : undefined,
                      onSubmit: ({ value }) =>
                        isValidTemplateName(value) ? undefined : m.records_template_name_hint(),
                    }}
                  >
                    {(field) => (
                      <field.Input
                        size={controlSize}
                        maxLength={100}
                        label={m.records_template_name()}
                        hideRequiredIndicator
                        placeholder={m.records_template_name_placeholder()}
                        hint={m.records_template_name_hint()}
                      />
                    )}
                  </form.AppField>

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
                          <div className="relative ms-3 space-y-2 border-s-2 border-secondary ps-4">
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
                        <div className="ps-1">
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
                    <Button type="button" size={controlSize} color="secondary" onPress={addSection}>
                      {m.records_template_add_heading_level_one()}
                    </Button>
                  </div>

                  <TemplateRecipientsField
                    allMembers={allMembers}
                    recipientIds={recipientIds}
                    members={members}
                    recipientLabel={recipientLabel}
                    recipientOptions={recipientOptions}
                    selectedRecipientKeys={selectedRecipientKeys}
                    onClearAll={() => {
                      setAllMembers(false);
                      setRecipientIds([]);
                    }}
                    onToggleRecipient={toggleRecipient}
                    onRecipientSelectionChange={onRecipientSelectionChange}
                  />

                  <div className="grid gap-4 sm:grid-cols-2">
                    <form.AppField name="frequency">
                      {(field) => (
                        <field.Select
                          label={m.records_template_frequency()}
                          size={controlSize}
                          hideRequiredIndicator
                        >
                          <Select.Item id="weekly" label={m.records_template_frequency_weekly()} />
                        </field.Select>
                      )}
                    </form.AppField>
                    <form.AppField name="sendWeekday">
                      {(field) => (
                        <field.Select
                          label={m.records_template_send_weekday()}
                          size={controlSize}
                          hideRequiredIndicator
                        >
                          {SEND_WEEKDAYS.map((day) => (
                            <Select.Item key={day} id={String(day)} label={weekdayLabel(day)} />
                          ))}
                        </field.Select>
                      )}
                    </form.AppField>
                  </div>

                  <form.AppField name="sendTime">
                    {(field) => (
                      <field.Select
                        label={m.records_template_send_time()}
                        size={controlSize}
                        hideRequiredIndicator
                      >
                        {SEND_TIMES.map((time) => (
                          <Select.Item key={time} id={time} label={time} />
                        ))}
                      </field.Select>
                    )}
                  </form.AppField>

                  <form.AppField name="enabled">
                    {(field) => (
                      <field.Select
                        label={m.records_template_enabled()}
                        size={controlSize}
                        hideRequiredIndicator
                      >
                        <Select.Item id="yes" label={m.records_template_enabled_yes()} />
                        <Select.Item id="no" label={m.records_template_enabled_no()} />
                      </field.Select>
                    )}
                  </form.AppField>

                  <form.Alert />
                </SlideoutMenu.Content>

                <SlideoutMenu.Footer>
                  <DialogActions>
                    <DialogCancel type="button" isDisabled={saving} onPress={requestClose}>
                      {m.records_template_cancel()}
                    </DialogCancel>
                    <DialogAction type="submit" isDisabled={saving}>
                      {m.records_template_save()}
                    </DialogAction>
                  </DialogActions>
                </SlideoutMenu.Footer>
              </form>
            </form.AppForm>
          </SlideoutDialog>
        </SlideoutModal>
      </SlideoutOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
