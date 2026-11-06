import type { TaskPriority, TaskProjectRef, TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRight, XClose } from "@untitledui/icons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Heading, Input as AriaInput, TextArea } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { DialogAction, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "./task-assignment";
import { AssigneeMenu } from "./task-assignee-menu";
import { TaskLabelsField } from "./task-labels";
import { TaskProjectMenu } from "./task-project-menu";
import { TaskPriorityMenu } from "./task-priority-menu";
import { TaskProperty } from "./task-property";
import { TaskStatusIcon } from "./task-status-icon";
import { useTaskAssignmentAccess } from "./use-task-assignment-access";
import { loadTaskCreateDefaults } from "./tasks.functions";
import { useWorkspaceLabels } from "./workspace-labels";

/** What a new Task is made with: its title, and what else was set before it was created. */
export type TaskDraft = {
  title: string;
  description?: string;
  /** The assignee bound by id (`user:<id>` or `agent:<id>`). */
  assignee?: string;
  /** Label names. */
  labels?: string[];
  /** Left out for none, the server's default. */
  priority?: TaskPriority;
  /** A Project by slug, or null for none; absent where the form offers no Project (a sub-task
   * takes its parent's). */
  project?: string | null;
};

/**
 * A new Task, laid out as the Task popup lays out a Task (Frank, 11-05: "按照我们目前 task 的设计"):
 * where it goes above (the conversation, or the Task it is a step of), its title beside its To do
 * status, its owner and labels as the popup's chips, then its description. One Task per dialog
 * (Frank, 11-05: "就一次建一个吧"). In a conversation its Project is a chip too, starting at the one
 * the viewer last filed a Task under there, which a create naming none would take (task #485); a
 * sub-task takes its parent's, so it offers none.
 */
export function CreateTaskDialog({
  open,
  onOpenChange,
  onCreate,
  describeError,
  where,
  members,
  conversationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: TaskDraft, idempotencyKey: string) => Promise<void>;
  /** Words a refusal the caller knows the reason for (a sub-task under a Task that cannot take
   * one); anything else reads as the plain failure. */
  describeError?: (cause: unknown) => string | undefined;
  /** Where the Task goes, as the popup's trail names it: `#channel`, or `#12 Parent title`. */
  where?: { label: string; subtask?: boolean };
  /** Who may be its owner; without them, no owner is offered. Someone who may not assign others
   * is offered only themselves, as in the popup. */
  members?: readonly Mentionable[];
  /** The conversation the Task goes in, so the form offers its Project. Absent for a sub-task. */
  conversationId?: string;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  // A retry of the same Task reuses its idempotency key, so a create that did land is not repeated.
  const submission = useRef<{ key: string; idempotencyKey: string } | undefined>(undefined);
  const { labels: workspaceLabels } = useWorkspaceLabels(draft.labels.length > 0);
  const access = useTaskAssignmentAccess();
  const assignable = access.canAssignOthers
    ? members
    : members?.filter((member) => member.kind === "user" && member.id === access.userId);
  const loadDefaults = useServerFn(loadTaskCreateDefaults);
  const defaults = useQuery({
    queryKey: ["task-create-defaults", conversationId],
    queryFn: () => loadDefaults({ data: { conversationId: conversationId! } }),
    enabled: open && conversationId !== undefined,
    staleTime: 0,
  });
  // The Project starts at the last-used one, once it is read; a pick made since stays.
  useEffect(() => {
    if (defaults.data && draft.project === undefined)
      setDraft((current) =>
        current.project === undefined ? { ...current, project: defaults.data.project } : current,
      );
  }, [defaults.data, draft.project]);
  // A Task its creator takes on is made started, as the server makes it.
  const status = draft.assignee === `user:${access.userId}` ? "in_progress" : "todo";

  const owner = members?.find((member) => `${member.kind}:${member.id}` === draft.assignee);
  const draftTask: Pick<TaskView, "owner" | "labels" | "project"> = {
    project: draft.project ?? null,
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
    labels: draft.labels.flatMap((name) => {
      // The Workspace's labels hold the archived ones too (task #557); a draft names a live one.
      const label = workspaceLabels.find((each) => each.name === name && !each.archivedAt);
      return label ? [{ id: label.id, name: label.name, color: label.color }] : [];
    }),
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
    const description = draft.description.trim();
    const made: TaskDraft = {
      title,
      ...(description && { description }),
      ...(draft.assignee && { assignee: draft.assignee }),
      ...(draft.labels.length > 0 && { labels: draft.labels }),
      ...(draft.priority !== "none" && { priority: draft.priority }),
      ...(conversationId !== undefined &&
        draft.project !== undefined && { project: draft.project?.slug ?? null }),
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
      await onCreate(made, request.idempotencyKey);
      submission.current = undefined;
      setDraft(emptyDraft());
      onOpenChange(false);
    } catch (cause) {
      // Assigning others was taken away meanwhile: say so, and offer only oneself from now on.
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
      className="max-sm:items-stretch max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px]"
    >
      <Modal className="flex w-full flex-col overflow-hidden max-sm:h-full max-sm:rounded-none max-sm:safe-area-padding sm:w-[min(44rem,calc(100vw-2rem))]">
        <Dialog aria-label={heading} className="flex min-h-0 flex-1 flex-col">
          {({ close }) => (
            <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
              {/* Where it goes, as the popup's trail: the conversation, or the Task above it. */}
              <div className="flex shrink-0 items-center gap-1 pt-2 pr-3 pl-4 sm:pl-6">
                <p className="flex min-w-0 flex-1 items-center gap-1 text-sm text-tertiary">
                  {where && (
                    <>
                      <span className="truncate">{where.label}</span>
                      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                    </>
                  )}
                  <span className="shrink-0 text-secondary">{heading}</span>
                </p>
                <ButtonUtility
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  aria-label={m.tasks_close()}
                  isDisabled={saving}
                  onClick={close}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Heading
                  slot="title"
                  level={2}
                  className="flex items-start gap-2 px-4 pt-3 sm:px-6"
                >
                  <TaskStatusIcon status={status} className="mt-1.5 size-5" />
                  <AriaInput
                    ref={titleRef}
                    aria-label={m.tasks_new_title()}
                    placeholder={m.tasks_new_title()}
                    value={draft.title}
                    onChange={(event) => change({ title: event.target.value })}
                    maxLength={500}
                    disabled={saving}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-primary outline-hidden placeholder:font-medium placeholder:text-placeholder"
                  />
                </Heading>
                {/* The popup's chips: its owner, Project and labels, each its own control. */}
                <div
                  data-layout="chips"
                  className="mt-3 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
                >
                  {assignable && (
                    <TaskProperty label={m.tasks_overview_owner()}>
                      <AssigneeMenu
                        task={draftTask}
                        members={assignable}
                        disabled={saving}
                        onSelect={(assignee) => change({ assignee: assignee ?? undefined })}
                      />
                    </TaskProperty>
                  )}
                  <TaskProperty label={m.tasks_priority()}>
                    <TaskPriorityMenu
                      priority={draft.priority}
                      disabled={saving}
                      onSelect={(priority) => change({ priority })}
                    />
                  </TaskProperty>
                  {conversationId !== undefined && (
                    <TaskProperty label={m.tasks_project()}>
                      <TaskProjectMenu
                        task={draftTask}
                        disabled={saving || draft.project === undefined}
                        onSelect={(project) => change({ project })}
                      />
                    </TaskProperty>
                  )}
                  <TaskProperty label={m.tasks_labels()}>
                    <TaskLabelsField
                      task={draftTask}
                      disabled={saving}
                      onChange={({ add = [], remove = [] }) =>
                        change({
                          labels: [
                            ...draft.labels.filter((name) => !remove.includes(name)),
                            ...add.filter((name) => !draft.labels.includes(name)),
                          ],
                        })
                      }
                    />
                  </TaskProperty>
                </div>
                <TextArea
                  aria-label={m.tasks_new_description()}
                  placeholder={m.tasks_new_description()}
                  value={draft.description}
                  onChange={(event) => change({ description: event.target.value })}
                  maxLength={50_000}
                  disabled={saving}
                  rows={4}
                  className="mt-4 block w-full resize-none bg-transparent px-4 pb-4 text-sm text-primary outline-hidden placeholder:text-placeholder sm:px-6"
                />
              </div>
              {error && (
                <p role="alert" className="shrink-0 px-4 pb-2 text-sm text-error-primary sm:px-6">
                  {error}
                </p>
              )}
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-secondary px-4 py-3 sm:px-6">
                <DialogCancel type="button" isDisabled={saving} onPress={close}>
                  {m.tasks_create_cancel()}
                </DialogCancel>
                <DialogAction type="submit" isLoading={saving}>
                  {m.tasks_new_submit()}
                </DialogAction>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const emptyDraft = () => ({
  title: "",
  description: "",
  assignee: undefined as string | undefined,
  labels: [] as string[],
  priority: "none" as TaskPriority,
  /** Undefined until the conversation's last-used Project is read. */
  project: undefined as TaskProjectRef | null | undefined,
});
