import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import type { MessageView } from "#src/features/conversations/message-view";
import type {
  SystemNotice,
  SystemPerson,
  SystemTask,
} from "#src/features/conversations/system-notice";

export type TaskEventPeople = {
  actor: (type: TaskHistoryEvent["actorType"], handle: string | null) => SystemPerson;
  assignee: (kind: "user" | "agent", id: string) => SystemPerson;
};

type Subject = { number: number };

const ADDRESSED_TWINS = new Set(["task.assigned", "task.assigned_you", "task.priority_changed"]);

export function taskEventNotice(
  event: TaskHistoryEvent,
  subject: Subject,
  people: TaskEventPeople,
): SystemNotice | null {
  const task: SystemTask = { taskId: null, number: subject.number, title: "" };
  const actor = people.actor(event.actorType, event.actorName);
  switch (event.eventType) {
    case "created":
      return { kind: "task.created", params: { tasks: [task] } };
    case "status_changed":
      return { kind: "task.moved", params: { actor, task, status: event.payload.to } };
    case "assignee_changed": {
      const { assigneeId, assigneeType } = event.payload;
      if (!assigneeId || !assigneeType) return { kind: "task.unassigned", params: { actor, task } };
      const assignee = people.assignee(assigneeType, assigneeId);
      return event.actorType === assigneeType && assignee.handle === event.actorName
        ? { kind: "task.claimed", params: { claimer: actor, task } }
        : { kind: "task.assigned", params: { actor, task, assignee } };
    }
    case "priority_changed":
      return { kind: "task.priority_changed", params: { actor, task, ...event.payload } };
    case "amended": {
      const { title, description } = event.payload.changes;
      if (!title && !description) return null;
      return {
        kind: "task.amended",
        params: { actor, task, ...(title && { title }), ...(description && { description: true }) },
      };
    }
    case "dependencies_changed":
      if (event.payload.added.length + event.payload.removed.length === 0) return null;
      return { kind: "task.dependencies_changed", params: { actor, task, ...event.payload } };
    case "parent_changed":
      if (!event.payload.from && !event.payload.to) return null;
      return { kind: "task.parent_changed", params: { actor, task, ...event.payload } };
    case "due_changed":
      return { kind: "task.due_changed", params: { actor, task, ...event.payload } };
    case "labels_changed": {
      const { added, removed } = event.payload;
      if (
        event.actorType === "system"
          ? removed.length === 0 || added.length > 0
          : added.length + removed.length === 0
      )
        return null;
      const named = (labels: typeof added) => labels.map(({ id, name }) => ({ id, name }));
      return {
        kind: "task.labels_changed",
        params: {
          ...(event.actorType !== "system" && { actor }),
          task,
          added: named(added),
          removed: named(removed),
        },
      };
    }
    case "project_changed": {
      if (!event.payload.from && !event.payload.to) return null;
      const named = (project: typeof event.payload.from) =>
        project && { id: project.id, name: project.name };
      return {
        kind: "task.project_changed",
        params: { actor, task, from: named(event.payload.from), to: named(event.payload.to) },
      };
    }
    default:
      return null;
  }
}

const at = (value: Date | string) => new Date(value).getTime();

function eventRow(
  event: TaskHistoryEvent,
  sequence: number,
  system: SystemNotice,
): MessageView & { system: SystemNotice } {
  return {
    id: `history:${event.id}`,
    sequence,
    senderKind: "system",
    senderName: "",
    body: "",
    createdAt: event.createdAt,
    attachments: [],
    system,
  };
}

export function withTaskEvents<M extends MessageView & { system?: { kind: string } }>(
  messages: readonly M[],
  events: readonly TaskHistoryEvent[],
  subject: Subject,
  people: TaskEventPeople,
): (M | (MessageView & { system: SystemNotice }))[] {
  if (events.length === 0) return [...messages];
  const shown = messages.filter((message) => !ADDRESSED_TWINS.has(message.system?.kind ?? ""));
  const rows: (M | (MessageView & { system: SystemNotice }))[] = [];
  let next = 0;
  const place = (before: number, waiting: readonly TaskHistoryEvent[]) =>
    waiting.forEach((event, index) => {
      const system = taskEventNotice(event, subject, people);
      if (system)
        rows.push(eventRow(event, before - 1 + (index + 1) / (waiting.length + 1), system));
    });
  for (const message of shown) {
    const start = next;
    while (next < events.length && at(events[next]!.createdAt) <= at(message.createdAt)) next++;
    place(message.sequence, events.slice(start, next));
    rows.push(message);
  }
  place((shown.at(-1)?.sequence ?? 0) + 1, events.slice(next));
  return rows;
}
