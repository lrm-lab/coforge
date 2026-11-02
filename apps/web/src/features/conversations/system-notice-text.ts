import type { TaskStatus } from "@lrm/coforge-sdk/internal";

import { m } from "#src/paraglide/messages";
import {
  isSystemNotice,
  type SystemNotice,
  type SystemPerson,
  type SystemTask,
} from "./system-notice";

/** A message as the surfaces that show a notice hold it: the stored English `body`, and the
 * structured content when the server attached it (`mapBrowserMessage`). */
export type SystemNoticeSource = { body: string; system?: { kind: string; params: unknown } };

/** The notice a message carries, when its stored kind and params are ones a renderer can trust. */
export function systemNoticeOf(message: SystemNoticeSource): SystemNotice | null {
  return message.system && isSystemNotice(message.system) ? message.system : null;
}

/** The emoji a task notice opens with, as the server's English text has it. */
const KIND_EMOJI: Partial<Record<SystemNotice["kind"], string>> = {
  "task.created": "📋",
  "task.converted": "📋",
  "task.from_message": "📋",
  "task.assigned": "📌",
  "task.claimed": "📌",
  "task.unassigned": "🔓",
};

const STATUS_EMOJI: Record<TaskStatus, string> = {
  todo: "📝",
  in_progress: "🔄",
  in_review: "👀",
  done: "✅",
  closed: "🚫",
};

/** The task board's own names for the statuses. */
const STATUS_LABEL: Record<TaskStatus, () => string> = {
  todo: m.tasks_status_todo,
  in_progress: m.tasks_status_in_progress,
  in_review: m.tasks_status_in_review,
  done: m.tasks_status_done,
  closed: m.tasks_status_closed,
};

/** Someone acting in a notice is named as people see them; someone it is about (an assignee, a
 * coordinator) as the mention they would be written as. */
const shown = (person: SystemPerson) => person.displayName || person.handle;
const mention = (person: SystemPerson) => `@${person.handle}`;

const reference = (task: SystemTask) =>
  task.title
    ? m.system_notice_task_reference({ number: task.number, title: task.title })
    : m.system_notice_task_number({ number: task.number });

function noticeText(notice: SystemNotice): string {
  switch (notice.kind) {
    case "task.created": {
      const { tasks } = notice.params;
      return m.system_notice_task_created({
        count: tasks.length,
        // A list already says what its items are: each is the number and title alone.
        tasks: tasks
          .map((task) =>
            task.title
              ? m.system_notice_task_list_item({ number: task.number, title: task.title })
              : `#${task.number}`,
          )
          .join(m.system_notice_list_separator()),
      });
    }
    case "task.converted":
      return m.system_notice_task_converted({
        actor: shown(notice.params.actor),
        task: reference(notice.params.task),
      });
    case "task.from_message":
      return m.system_notice_task_from_message({
        actor: shown(notice.params.actor),
        task: reference(notice.params.task),
      });
    case "task.assigned":
      return m.system_notice_task_assigned({
        actor: shown(notice.params.actor),
        task: reference(notice.params.task),
        assignee: mention(notice.params.assignee),
      });
    case "task.claimed":
      return m.system_notice_task_claimed({
        actor: shown(notice.params.claimer),
        task: reference(notice.params.task),
      });
    case "task.moved":
      return `${STATUS_EMOJI[notice.params.status]} ${m.system_notice_task_moved({
        actor: shown(notice.params.actor),
        task: reference(notice.params.task),
        status: STATUS_LABEL[notice.params.status](),
      })}`;
    case "task.unassigned":
      return m.system_notice_task_unassigned({
        actor: shown(notice.params.actor),
        task: reference(notice.params.task),
      });
    case "task.unfollowed": {
      const { actor, reason } = notice.params;
      return reason
        ? m.system_notice_task_unfollowed_reason({ actor: shown(actor), reason })
        : m.system_notice_task_unfollowed({ actor: shown(actor) });
    }
    case "task.assigned_you":
      return m.system_notice_task_assigned_you({
        actor: shown(notice.params.actor),
        task: reference(notice.params.task),
      });
    case "channel.coordinator_changed": {
      const { actor, previous, next, channelName } = notice.params;
      if (!next && previous)
        return m.system_notice_coordinator_removed({
          actor: shown(actor),
          previous: mention(previous),
          channel: channelName,
        });
      if (next && previous)
        return m.system_notice_coordinator_replaced({
          actor: shown(actor),
          next: mention(next),
          previous: mention(previous),
          channel: channelName,
        });
      if (next)
        return m.system_notice_coordinator_set({
          actor: shown(actor),
          next: mention(next),
          channel: channelName,
        });
      return "";
    }
    case "agent_dm.chain_limit":
      return m.system_notice_agent_dm_chain_limit();
    case "agent_dm.rate_limit":
      return m.system_notice_agent_dm_rate_limit();
    case "legacy_text":
      return "";
  }
}

/**
 * A notice as the viewer reads it: rendered from its kind in the viewer's language, opening with
 * the emoji the server's text uses. A message with no structured content, a `legacy_text` one or
 * one whose params do not check out reads as its stored body.
 */
export function systemNoticeText(message: SystemNoticeSource): string {
  const notice = systemNoticeOf(message);
  const text = notice ? noticeText(notice) : "";
  if (!text) return message.body;
  const emoji = notice && KIND_EMOJI[notice.kind];
  return emoji ? `${emoji} ${text}` : text;
}
