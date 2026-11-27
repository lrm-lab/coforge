import type { TaskProjectRef, TaskWriteStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { useStore } from "@tanstack/react-form";
import { ChevronRight, XClose } from "@untitledui/icons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Heading, TextArea } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { DialogAction } from "#src/components/ui/dialog-actions";
import { useAppForm, visibleFieldError } from "#src/components/ui/form";
import { HotkeyKeycaps } from "#src/components/ui/kbd";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { isAppError } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { isImeComposing } from "#src/lib/ime";
import { m } from "#src/paraglide/messages";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "./task-assignment";
import { CreateTaskProperties } from "./create-task-properties";
import { TaskDialogWhere } from "./task-dialog-where";
import { PhoneFormBar } from "#src/components/ui/phone-form-bar";
import { cn } from "#src/lib/utils";
import { TaskStatusIcon } from "./task-status-icon";
import { useTaskAssignmentAccess } from "./use-task-assignment-access";
import { useLastTaskProject } from "./use-last-task-project";
import { draftLabels, useWorkspaceLabels } from "./workspace-labels";
import { emptyDraft, type TaskDraft } from "./task-draft";
import { TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "./task-command-schema";
import { registerUnsavedTemporaryState } from "#src/features/updates/build-update";

export function CreateTaskDialog({
  open,
  onOpenChange,
  onCreate,
  describeError,
  where,
  members,
  conversationId,
  board,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: TaskDraft, idempotencyKey: string, options: { more: boolean }) => Promise<void>;
  describeError?: (cause: unknown) => string | undefined;
  where?: { label: string; subtask?: boolean };
  members?: readonly Mentionable[];
  conversationId?: string;
  board?: {
    place: ReactNode;
    status: TaskWriteStatus;
    statuses: readonly TaskWriteStatus[];
    onStatusChange: (status: TaskWriteStatus) => void;
    project?: TaskProjectRef;
  };
}) {
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const busy = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submission = useRef<{ key: string; idempotencyKey: string } | undefined>(undefined);
  const access = useTaskAssignmentAccess();
  const offersProject = conversationId !== undefined || board !== undefined;

  const form = useAppForm({
    defaultValues: emptyDraft(),
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (busy.current) return;
      const title = value.title.trim();
      const priority = value.priority;
      if (!priority) {
        setError(m.tasks_priority_required());
        return;
      }
      const selectedProject =
        value.project !== undefined ? value.project : (board?.project ?? null);
      const description = value.description.trim();
      const made: TaskDraft = {
        title,
        ...(description && { description }),
        ...(value.assignee && { assignee: value.assignee }),
        ...(value.labels.length > 0 && { labels: value.labels }),
        priority,
        ...(value.dueAt && {
          dueAt: value.dueAt,
          ...(value.dueHasTime !== undefined && { dueHasTime: value.dueHasTime }),
        }),
        ...(offersProject && { project: selectedProject?.slug ?? null }),
      };
      const key = JSON.stringify(made);
      const request =
        submission.current?.key === key
          ? submission.current
          : { key, idempotencyKey: crypto.randomUUID() };
      submission.current = request;
      busy.current = true;
      setError("");
      try {
        await onCreate(made, request.idempotencyKey, { more });
        submission.current = undefined;
        if (more) {
          form.reset({ ...value, title: "", description: "" });
          titleRef.current?.focus();
        } else {
          form.reset(emptyDraft());
          onOpenChange(false);
        }
      } catch (cause) {
        if (isAppError(cause) && cause.errorId === TASK_ASSIGNMENT_MANAGER_REQUIRED) {
          void access.refetch();
          form.setFieldValue("assignee", undefined);
          setError(m.tasks_assignment_requires_workspace_manager());
          return;
        }
        setError(describeError?.(cause) ?? m.tasks_create_error());
      } finally {
        busy.current = false;
      }
    },
  });

  const { draft, saving } = useStore(form.store, (state) => ({
    draft: state.values,
    saving: state.isSubmitting,
  }));

  const dirty =
    draft.title.trim() !== "" ||
    draft.description?.trim() !== "" ||
    draft.assignee !== undefined ||
    (draft.labels?.length ?? 0) > 0 ||
    draft.priority !== undefined ||
    draft.project !== undefined ||
    draft.dueAt !== undefined;
  useEffect(() => registerUnsavedTemporaryState(open && dirty), [open, dirty]);
  const guard = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty,
    close: () => onOpenChange(false),
    onDiscard: () => {
      form.reset(emptyDraft());
      setError("");
    },
  });
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title || CSS.supports("field-sizing", "content")) return;
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  }, [open, draft.title]);

  const { labels: workspaceLabels } = useWorkspaceLabels(draft.labels.length > 0);
  const assignable = access.canAssignOthers
    ? members
    : members?.filter((member) => member.kind === "user" && member.id === access.userId);
  const lastProject = useLastTaskProject(conversationId, open);
  const status =
    board?.status ?? (draft.assignee === `user:${access.userId}` ? "in_progress" : "todo");
  const project = draft.project !== undefined ? draft.project : (board?.project ?? null);

  const owner = members?.find((member) => `${member.kind}:${member.id}` === draft.assignee);
  const draftTask: Pick<TaskView, "owner" | "labels" | "project"> = {
    project,
    owner: owner
      ? {
          memberId: "",
          kind: owner.kind,
          id: owner.id,
          name: owner.label,
          handle: owner.handle,
          avatarUrl: owner.avatarUrl ?? null,
        }
      : null,
    labels: draftLabels(draft.labels, workspaceLabels),
  };

  function change(patch: Partial<ReturnType<typeof emptyDraft>>) {
    setError("");
    for (const [key, value] of Object.entries(patch)) {
      form.setFieldValue(key as keyof ReturnType<typeof emptyDraft>, value as never);
    }
  }

  const heading = where?.subtask ? m.tasks_new_subtask() : m.tasks_new_task();
  return (
    <>
      <ModalOverlay
        isOpen={open}
        onOpenChange={(value) => {
          if (busy.current) return;
          if (value) onOpenChange(true);
          else guard.requestClose();
        }}
        isDismissable
        page
      >
        <Modal className="flex w-full flex-col overflow-hidden sm:w-[min(44rem,calc(100vw-2rem))]">
          <Dialog aria-label={heading} className="flex min-h-0 flex-1 flex-col">
            {() => (
              <form.AppForm>
                <form
                  ref={formRef}
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey) &&
                      !event.repeat
                    ) {
                      event.preventDefault();
                      event.currentTarget.requestSubmit();
                    }
                  }}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <PhoneFormBar
                    heading={heading}
                    submitLabel={m.tasks_create_submit_short()}
                    pending={saving}
                    onCancel={guard.requestClose}
                    onSubmit={() => formRef.current?.requestSubmit()}
                  />
                  <div
                    className={cn(
                      "flex shrink-0 items-center gap-1 pt-3 pe-3 ps-4 max-sm:pt-1 sm:ps-6",
                      !(board || where) && "max-sm:hidden",
                    )}
                  >
                    <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-tertiary">
                      {(board || where) && (
                        <>
                          <span
                            data-layout="create"
                            className="inline-flex h-8 min-w-0 items-center rounded-lg bg-secondary text-secondary ring-1 ring-secondary ring-inset"
                          >
                            {board?.place ?? (
                              <TaskDialogWhere
                                label={where?.label ?? ""}
                                channelId={where && !where.subtask ? conversationId : undefined}
                              />
                            )}
                          </span>
                          <ChevronRight
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-fg-quaternary max-sm:hidden rtl:rotate-180"
                          />
                        </>
                      )}
                      <span className="shrink-0 max-sm:hidden">{heading}</span>
                    </p>
                    <ButtonUtility
                      icon={XClose}
                      size="sm"
                      color="tertiary"
                      tooltip={m.tasks_close()}
                      aria-label={m.tasks_close()}
                      isDisabled={saving}
                      onClick={guard.requestClose}
                      className="max-sm:hidden"
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <form.AppField
                      name="title"
                      validators={{
                        onSubmit: ({ value }) =>
                          value.trim() ? undefined : m.tasks_create_title_required(),
                      }}
                    >
                      {(field) => {
                        const titleError = visibleFieldError(
                          field.state.meta,
                          field.form.state.submissionAttempts,
                        );
                        return (
                          <>
                            <Heading
                              slot="title"
                              level={2}
                              className="flex items-start gap-2 px-4 pt-4 sm:px-6"
                            >
                              {!board && (
                                <TaskStatusIcon status={status} className="mt-1.5 size-5" />
                              )}
                              <TextArea
                                ref={titleRef}
                                name={field.name}
                                aria-label={m.tasks_new_title()}
                                placeholder={m.tasks_new_title()}
                                value={field.state.value}
                                onChange={(event) => {
                                  if (field.state.meta.errorMap.onSubmit) {
                                    field.setMeta((prev) => ({
                                      ...prev,
                                      errorMap: { ...prev.errorMap, onSubmit: undefined },
                                    }));
                                  }
                                  field.handleChange(event.target.value.replace(/\s*\n\s*/g, " "));
                                  setError("");
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter" || isImeComposing(event)) return;
                                  event.preventDefault();
                                  if (!event.repeat) event.currentTarget.form?.requestSubmit();
                                }}
                                maxLength={TASK_TITLE_MAX_LENGTH}
                                disabled={saving}
                                autoFocus
                                rows={1}
                                aria-invalid={Boolean(titleError) || undefined}
                                className="min-w-0 flex-1 resize-none bg-transparent text-xl font-semibold text-primary outline-hidden [field-sizing:content] placeholder:font-medium placeholder:text-placeholder"
                              />
                            </Heading>
                            {titleError && (
                              <p
                                role="alert"
                                className="mt-1 px-4 text-sm text-error-primary sm:px-6"
                              >
                                {titleError}
                              </p>
                            )}
                          </>
                        );
                      }}
                    </form.AppField>
                    <form.AppField name="description">
                      {(field) => (
                        <TextArea
                          name={field.name}
                          aria-label={m.tasks_new_description()}
                          placeholder={m.tasks_new_description()}
                          value={field.state.value}
                          onChange={(event) => {
                            field.handleChange(event.target.value);
                            setError("");
                          }}
                          maxLength={TASK_DESCRIPTION_MAX_LENGTH}
                          disabled={saving}
                          rows={3}
                          className="mt-2 block w-full resize-none bg-transparent px-4 pb-4 text-md text-secondary outline-hidden placeholder:text-placeholder sm:px-6"
                        />
                      )}
                    </form.AppField>
                  </div>
                  <CreateTaskProperties
                    board={board}
                    assignable={assignable}
                    task={draftTask}
                    offersProject={offersProject}
                    lastUsed={lastProject}
                    draft={draft}
                    saving={saving}
                    onChange={change}
                  />
                  <form.Alert
                    error={error}
                    className="shrink-0 px-4 pb-2 text-sm text-error-primary sm:px-6"
                  />
                  <div className="flex shrink-0 items-center justify-end gap-4 border-t border-secondary px-4 py-3 max-sm:hidden sm:px-6">
                    <Toggle
                      size="sm"
                      label={m.tasks_create_more()}
                      isSelected={more}
                      onChange={setMore}
                      isDisabled={saving}
                    />
                    <DialogAction type="submit" isLoading={saving} isDisabled={!draft.priority}>
                      {m.tasks_new_submit()}
                      <HotkeyKeycaps
                        hotkey="Mod+Enter"
                        size="xs"
                        tone="current"
                        hideOnTouch
                        ariaHidden
                        className="ms-1.5"
                      />
                    </DialogAction>
                  </div>
                </form>
              </form.AppForm>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...guard.promptProps} />
    </>
  );
}
