import type { TaskPriority, TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type FormEvent } from "react";
import { Heading } from "react-aria-components";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { DialogAction, DialogCancel } from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { LabelDot } from "./task-label-chip";
import { TaskPriorityIcon } from "./task-priority-icon";
import { statusLabel } from "./task-status-icon";
import { executeTask } from "./tasks.functions";
import { priorityLabel } from "./task-history-more";
import { m } from "#src/paraglide/messages";

/** A channel a new Task can go in: its conversation and, on a Project's board, the Project the
 * Task is filed under. */
export type NewTaskPlace = { conversationId: string; label: string; projectSlug?: string };

/** The columns a new Task can start in; Closed is for work that was dropped. */
const STATUSES = ["todo", "in_progress", "in_review", "done"] as const satisfies TaskStatus[];
export const canCreateIn = (status: TaskStatus) =>
  (STATUSES as readonly TaskStatus[]).includes(status);
const PRIORITIES = ["low", "medium", "high", "urgent"] as const satisfies TaskPriority[];

/**
 * "New task" on the board (task #596): its name, which channel it lands in and in which column,
 * who has it, its labels and priority; the footer says where it lands. A Task lives in a channel,
 * so the channel is asked for, starting at the one the board's Tasks were last filed in.
 */
export function BoardNewTaskDialog({
  open,
  status,
  places,
  people,
  labels,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** The column it was opened from. */
  status: TaskStatus;
  places: readonly NewTaskPlace[];
  people: readonly NonNullable<TaskView["owner"]>[];
  labels: readonly { id: string; name: string; color: string }[];
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const execute = useServerFn(executeTask);
  const [title, setTitle] = useState("");
  const [place, setPlace] = useState(places[0]?.conversationId);
  const [column, setColumn] = useState<TaskStatus>(status);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [owner, setOwner] = useState<string>("none");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setColumn(status);
  }, [open, status]);
  useEffect(() => {
    if (!place && places[0]) setPlace(places[0].conversationId);
  }, [place, places]);
  const where = places.find((each) => each.conversationId === place);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !where) return;
    setSaving(true);
    try {
      const owned = people.find((person) => `${person.kind}:${person.id}` === owner);
      await execute({
        data: {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: where.conversationId,
          title: title.trim(),
          ...(where.projectSlug && { project: where.projectSlug }),
          priority,
          ...(picked.size > 0 && {
            labels: labels.filter((each) => picked.has(each.id)).map((each) => each.name),
          }),
          ...(owned && { assignee: `${owned.kind}:${owned.id}` }),
          ...(column !== "todo" && { status: column }),
        },
      });
      setTitle("");
      onCreated();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="w-full sm:w-[min(32rem,calc(100vw-2rem))]">
        <Dialog aria-label={m.task_board_create_new_task()} className="flex flex-col">
          {({ close }) => (
            <form onSubmit={(event) => void submit(event)} className="flex flex-col">
              <Heading
                slot="title"
                level={2}
                className="border-b border-secondary px-6 py-4 text-md font-semibold text-primary"
              >
                {m.task_board_create_new_task()}
              </Heading>
              <div className="flex flex-col gap-5 px-6 py-5">
                <Input
                  label={m.task_board_create_task()}
                  placeholder={m.task_board_create_task_placeholder()}
                  value={title}
                  onChange={setTitle}
                  autoFocus
                  maxLength={500}
                  hideRequiredIndicator
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select
                    size="sm"
                    label={m.task_board_create_channel()}
                    selectedKey={place ?? null}
                    onSelectionChange={(key) => key && setPlace(String(key))}
                  >
                    {places.map((each) => (
                      <Select.Item
                        key={each.conversationId}
                        id={each.conversationId}
                        label={each.label}
                      />
                    ))}
                  </Select>
                  <Select
                    size="sm"
                    label={m.task_board_create_column()}
                    selectedKey={column}
                    onSelectionChange={(key) => key && setColumn(key as TaskStatus)}
                  >
                    {STATUSES.map((each) => (
                      <Select.Item key={each} id={each} label={statusLabel(each)} />
                    ))}
                  </Select>
                  <Select
                    size="sm"
                    label={m.task_board_create_owner()}
                    selectedKey={owner}
                    onSelectionChange={(key) => key && setOwner(String(key))}
                  >
                    {[
                      <Select.Item key="none" id="none" label={m.tasks_unassigned()} />,
                      ...people.map((person) => (
                        <Select.Item
                          key={`${person.kind}:${person.id}`}
                          id={`${person.kind}:${person.id}`}
                          label={person.name}
                          avatarUrl={person.avatarUrl ?? undefined}
                        />
                      )),
                    ]}
                  </Select>
                </div>
                {labels.length > 0 && (
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="mb-1.5 text-sm font-medium text-secondary">
                      {m.task_board_create_labels()}
                    </legend>
                    <ButtonGroup
                      size="sm"
                      selectionMode="multiple"
                      selectedKeys={picked}
                      onSelectionChange={(keys) => setPicked(new Set([...keys].map(String)))}
                      aria-label={m.task_board_create_labels()}
                    >
                      {labels.map((each) => (
                        <ButtonGroupItem
                          key={each.id}
                          id={each.id}
                          iconLeading={<LabelDot color={each.color} />}
                        >
                          {each.name}
                        </ButtonGroupItem>
                      ))}
                    </ButtonGroup>
                  </fieldset>
                )}
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 text-sm font-medium text-secondary">
                    {m.task_board_create_priority()}
                  </legend>
                  <ButtonGroup
                    size="sm"
                    selectedKeys={[priority]}
                    disallowEmptySelection
                    onSelectionChange={(keys) => {
                      const [key] = [...keys];
                      if (key) setPriority(key as TaskPriority);
                    }}
                    aria-label={m.task_board_create_priority()}
                  >
                    {PRIORITIES.map((each) => (
                      <ButtonGroupItem
                        key={each}
                        id={each}
                        iconLeading={
                          <TaskPriorityIcon
                            priority={each}
                            className="size-3.5 text-fg-quaternary"
                          />
                        }
                      >
                        {priorityLabel(each)}
                      </ButtonGroupItem>
                    ))}
                  </ButtonGroup>
                </fieldset>
              </div>
              <div className="flex items-center gap-3 border-t border-secondary px-6 py-4">
                <p className="min-w-0 flex-1 truncate text-sm text-tertiary">
                  {where &&
                    m.task_board_create_lands({
                      channel: where.label,
                      status: statusLabel(column),
                    })}
                </p>
                <DialogCancel type="button" isDisabled={saving} onPress={close}>
                  {m.task_board_create_cancel()}
                </DialogCancel>
                <DialogAction type="submit" isLoading={saving} isDisabled={!title.trim() || !where}>
                  {m.task_board_create_submit()}
                </DialogAction>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * What the dialog offers on a board, read from the Tasks the board shows: their channels, the one
 * most recently filed in first (a direct conversation is no channel to file in), the people who
 * hold them and their labels. On a Project's board `projectSlug` files the new Task under that
 * Project; on All tasks it goes under none.
 */
export function newTaskChoices(
  tasks: readonly {
    conversationId: string;
    createdAt: string;
    source?: { label: string };
    owner?: TaskView["owner"];
    labels?: TaskView["labels"];
  }[],
  projectSlug?: string,
) {
  const byConversation = new Map<string, NewTaskPlace & { at: string }>();
  const byOwner = new Map<string, NonNullable<TaskView["owner"]>>();
  const byLabel = new Map<string, { id: string; name: string; color: string }>();
  for (const task of tasks) {
    if (task.owner) byOwner.set(`${task.owner.kind}:${task.owner.id}`, task.owner);
    for (const label of task.labels ?? []) byLabel.set(label.id, label);
    if (!task.source || task.source.label.startsWith("@")) continue;
    const known = byConversation.get(task.conversationId);
    if (!known || known.at < task.createdAt)
      byConversation.set(task.conversationId, {
        conversationId: task.conversationId,
        label: task.source.label,
        projectSlug,
        at: task.createdAt,
      });
  }
  return {
    places: [...byConversation.values()].sort((a, b) => b.at.localeCompare(a.at)),
    people: [...byOwner.values()],
    labels: [...byLabel.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
