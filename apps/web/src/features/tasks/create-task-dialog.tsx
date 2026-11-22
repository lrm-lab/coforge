import type { TaskProjectRef, TaskWriteStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { ChevronRight, XClose } from "@untitledui/icons";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Heading, TextArea } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Toggle } from "#src/components/base/toggle/toggle";
import { DialogAction } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { isAppError } from "#src/lib/app-error";
import { isImeComposing } from "#src/lib/ime";
import { isApplePlatform } from "#src/lib/platform";
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
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const dirty =
      draft.title.trim() !== "" ||
      draft.description?.trim() !== "" ||
      draft.assignee !== undefined ||
      (draft.labels?.length ?? 0) > 0 ||
      draft.priority !== undefined ||
      draft.project !== undefined;
    return registerUnsavedTemporaryState(open && dirty);
  }, [open, draft]);
  const busy = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title || CSS.supports("field-sizing", "content")) return;
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  }, [open, draft.title]);
  const submission = useRef<{ key: string; idempotencyKey: string } | undefined>(undefined);
  const { labels: workspaceLabels } = useWorkspaceLabels(draft.labels.length > 0);
  const access = useTaskAssignmentAccess();
  const assignable = access.canAssignOthers
    ? members
    : members?.filter((member) => member.kind === "user" && member.id === access.userId);
  const lastProject = useLastTaskProject(conversationId, open);
  const status =
    board?.status ?? (draft.assignee === `user:${access.userId}` ? "in_progress" : "todo");
  const project = draft.project !== undefined ? draft.project : (board?.project ?? null);
  const offersProject = conversationId !== undefined || board !== undefined;

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

  function change(patch: Partial<typeof draft>) {
    setError("");
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const title = draft.title.trim();
    if (!title) {
      setError(m.tasks_create_title_required());
      titleRef.current?.focus();
      return;
    }
    const priority = draft.priority;
    if (!priority) {
      setError(m.tasks_priority_required());
      return;
    }
    const description = draft.description.trim();
    const made: TaskDraft = {
      title,
      ...(description && { description }),
      ...(draft.assignee && { assignee: draft.assignee }),
      ...(draft.labels.length > 0 && { labels: draft.labels }),
      priority,
      ...(draft.dueAt && {
        dueAt: draft.dueAt,
        ...(draft.dueHasTime !== undefined && { dueHasTime: draft.dueHasTime }),
      }),
      ...(offersProject && { project: project?.slug ?? null }),
    };
    const key = JSON.stringify(made);
    const request =
      submission.current?.key === key
        ? submission.current
        : { key, idempotencyKey: crypto.randomUUID() };
    submission.current = request;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(made, request.idempotencyKey, { more });
      submission.current = undefined;
      if (more) {
        setDraft((current) => ({ ...current, title: "", description: "" }));
        titleRef.current?.focus();
      } else {
        setDraft(emptyDraft());
        onOpenChange(false);
      }
    } catch (cause) {
      if (isAppError(cause) && cause.errorId === TASK_ASSIGNMENT_MANAGER_REQUIRED) {
        void access.refetch();
        change({ assignee: undefined });
        setError(m.tasks_assignment_requires_workspace_manager());
        return;
      }
      setError(describeError?.(cause) ?? m.tasks_create_error());
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const heading = where?.subtask ? m.tasks_new_subtask() : m.tasks_new_task();
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => !busy.current && onOpenChange(value)}
      isDismissable
      page
    >
      <Modal className="flex w-full flex-col overflow-hidden sm:w-[min(44rem,calc(100vw-2rem))]">
        <Dialog aria-label={heading} className="flex min-h-0 flex-1 flex-col">
          {({ close }) => (
            <form
              ref={formRef}
              onSubmit={(event) => void submit(event)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.repeat) {
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
                onCancel={close}
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
                  aria-label={m.tasks_close()}
                  isDisabled={saving}
                  onClick={close}
                  className="max-sm:hidden"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Heading
                  slot="title"
                  level={2}
                  className="flex items-start gap-2 px-4 pt-4 sm:px-6"
                >
                  {!board && <TaskStatusIcon status={status} className="mt-1.5 size-5" />}
                  <TextArea
                    ref={titleRef}
                    aria-label={m.tasks_new_title()}
                    placeholder={m.tasks_new_title()}
                    value={draft.title}
                    onChange={(event) =>
                      change({ title: event.target.value.replace(/\s*\n\s*/g, " ") })
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || isImeComposing(event)) return;
                      event.preventDefault();
                      if (!event.repeat) event.currentTarget.form?.requestSubmit();
                    }}
                    maxLength={TASK_TITLE_MAX_LENGTH}
                    disabled={saving}
                    autoFocus
                    rows={1}
                    className="min-w-0 flex-1 resize-none bg-transparent text-xl font-semibold text-primary outline-hidden [field-sizing:content] placeholder:font-medium placeholder:text-placeholder"
                  />
                </Heading>
                <TextArea
                  aria-label={m.tasks_new_description()}
                  placeholder={m.tasks_new_description()}
                  value={draft.description}
                  onChange={(event) => change({ description: event.target.value })}
                  maxLength={TASK_DESCRIPTION_MAX_LENGTH}
                  disabled={saving}
                  rows={3}
                  className="mt-2 block w-full resize-none bg-transparent px-4 pb-4 text-md text-secondary outline-hidden placeholder:text-placeholder sm:px-6"
                />
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
              {error && (
                <p role="alert" className="shrink-0 px-4 pb-2 text-sm text-error-primary sm:px-6">
                  {error}
                </p>
              )}
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
                  <kbd
                    aria-hidden="true"
                    className="ms-1.5 inline-flex items-center rounded-xs px-1 py-0.5 font-body text-xs leading-none font-medium ring-1 ring-current/35 ring-inset any-pointer-coarse:hidden"
                  >
                    {isApplePlatform() ? "⌘↵" : "Ctrl ↵"}
                  </kbd>
                </DialogAction>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
