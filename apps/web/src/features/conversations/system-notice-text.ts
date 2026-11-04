import type { TaskStatus } from "@lrm/coforge-sdk/internal";

import { m } from "#src/paraglide/messages";
import type { Locale } from "#src/paraglide/runtime";
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
  "task.unblocked": "🚦",
  "task.released": "🚦",
  "task.blocked": "⛔",
  "task.subtasks_finished": "✅",
};

const STATUS_EMOJI: Record<TaskStatus, string> = {
  todo: "📝",
  in_progress: "🔄",
  in_review: "👀",
  done: "✅",
  closed: "🚫",
};

/** The task board's own names for the statuses. */
const STATUS_LABEL: Record<TaskStatus, (locale?: Locale) => string> = {
  todo: (locale) => m.tasks_status_todo({}, { locale }),
  in_progress: (locale) => m.tasks_status_in_progress({}, { locale }),
  in_review: (locale) => m.tasks_status_in_review({}, { locale }),
  done: (locale) => m.tasks_status_done({}, { locale }),
  closed: (locale) => m.tasks_status_closed({}, { locale }),
};

/** How a notice writes the people it names: as text, or (`systemNoticeParts`) as a marker the
 * row puts a face and name in place of. */
type Names = {
  /** Someone acting in a notice, as people see them. */
  shown: (person: SystemPerson) => string;
  /** A member record's name as the stored body writes it: a person's display name, an Agent's
   * @handle (Raft's @Dax style). */
  memberName: (member: SystemPerson & { kind?: string }) => string;
  /** Someone a notice is about (an assignee, a coordinator), as the mention they would be
   * written as. */
  mention: (person: SystemPerson) => string;
};

const shownText = (person: SystemPerson) => person.displayName || person.handle;
const TEXT_NAMES: Names = {
  shown: shownText,
  memberName: (member) => (member.kind === "agent" ? `@${member.handle}` : shownText(member)),
  mention: (person) => `@${person.handle}`,
};

const reference = (task: SystemTask, locale?: Locale) => {
  if (task.hidden) return m.system_notice_task_hidden({}, { locale });
  // A Task in another channel is named `channel:#number` (the template adds the leading `#`).
  const number = task.channel ? `${task.channel}:#${task.number}` : task.number;
  return task.title
    ? m.system_notice_task_reference({ number, title: task.title }, { locale })
    : m.system_notice_task_number({ number }, { locale });
};

/** A notice's text, followed by the owner it addresses when it names one. */
const addressed = (
  text: string,
  owner: SystemPerson | null | undefined,
  locale: Locale | undefined,
  names: Names,
) => (owner ? m.system_notice_addressed({ text, owner: names.mention(owner) }, { locale }) : text);

function noticeText(notice: SystemNotice, locale?: Locale, names: Names = TEXT_NAMES): string {
  const { shown, memberName, mention } = names;
  switch (notice.kind) {
    case "task.created": {
      const { tasks } = notice.params;
      return m.system_notice_task_created(
        {
          count: tasks.length,
          // A list already says what its items are: each is the number and title alone.
          tasks: tasks
            .map((task) =>
              task.title
                ? m.system_notice_task_list_item(
                    { number: task.number, title: task.title },
                    { locale },
                  )
                : `#${task.number}`,
            )
            .join(m.system_notice_list_separator({}, { locale })),
        },
        { locale },
      );
    }
    case "task.converted":
      return m.system_notice_task_converted(
        {
          actor: shown(notice.params.actor),
          task: reference(notice.params.task, locale),
        },
        { locale },
      );
    case "task.from_message":
      return m.system_notice_task_from_message(
        {
          actor: shown(notice.params.actor),
          task: reference(notice.params.task, locale),
        },
        { locale },
      );
    case "task.assigned":
      return m.system_notice_task_assigned(
        {
          actor: shown(notice.params.actor),
          task: reference(notice.params.task, locale),
          assignee: mention(notice.params.assignee),
        },
        { locale },
      );
    case "task.claimed":
      return m.system_notice_task_claimed(
        {
          actor: shown(notice.params.claimer),
          task: reference(notice.params.task, locale),
        },
        { locale },
      );
    case "task.moved":
      return `${STATUS_EMOJI[notice.params.status]} ${m.system_notice_task_moved(
        {
          actor: shown(notice.params.actor),
          task: reference(notice.params.task, locale),
          status: STATUS_LABEL[notice.params.status](locale),
        },
        { locale },
      )}`;
    case "task.unassigned":
      return m.system_notice_task_unassigned(
        {
          actor: shown(notice.params.actor),
          task: reference(notice.params.task, locale),
        },
        { locale },
      );
    case "task.unfollowed": {
      const { actor, reason } = notice.params;
      return reason
        ? m.system_notice_task_unfollowed_reason({ actor: shown(actor), reason }, { locale })
        : m.system_notice_task_unfollowed({ actor: shown(actor) }, { locale });
    }
    case "task.blocked":
      return addressed(
        m.system_notice_task_blocked(
          {
            task: reference(notice.params.task, locale),
            blockers: notice.params.blockers
              .map((blocker) => reference(blocker, locale))
              .join(m.system_notice_list_separator({}, { locale })),
          },
          { locale },
        ),
        notice.params.owner,
        locale,
        names,
      );
    case "task.deleted":
      return m.system_notice_task_deleted(
        { actor: shown(notice.params.actor), task: reference(notice.params.task, locale) },
        { locale },
      );
    case "task.released":
      return addressed(
        m.system_notice_task_released({ task: reference(notice.params.task, locale) }, { locale }),
        notice.params.owner,
        locale,
        names,
      );
    case "task.subtasks_finished":
      return addressed(
        m.system_notice_task_subtasks_finished(
          { task: reference(notice.params.task, locale) },
          { locale },
        ),
        notice.params.owner,
        locale,
        names,
      );
    case "task.unblocked":
      return addressed(
        m.system_notice_task_unblocked(
          {
            blocker: reference(notice.params.blocker, locale),
            task: reference(notice.params.task, locale),
          },
          { locale },
        ),
        notice.params.owner,
        locale,
        names,
      );
    case "task.assigned_you":
      return m.system_notice_task_assigned_you(
        {
          actor: shown(notice.params.actor),
          task: reference(notice.params.task, locale),
        },
        { locale },
      );
    case "channel.coordinator_changed": {
      const { actor, previous, next, channelName } = notice.params;
      if (!next && previous)
        return m.system_notice_coordinator_removed(
          {
            actor: shown(actor),
            previous: mention(previous),
            channel: channelName,
          },
          { locale },
        );
      if (next && previous)
        return m.system_notice_coordinator_replaced(
          {
            actor: shown(actor),
            next: mention(next),
            previous: mention(previous),
            channel: channelName,
          },
          { locale },
        );
      if (next)
        return m.system_notice_coordinator_set(
          {
            actor: shown(actor),
            next: mention(next),
            channel: channelName,
          },
          { locale },
        );
      return "";
    }
    case "channel.member_joined":
    case "channel.member_left": {
      const members = notice.params.members.map(memberName).join(", ");
      return notice.kind === "channel.member_joined"
        ? m.system_notice_channel_member_joined({ members }, { locale })
        : m.system_notice_channel_member_left({ members }, { locale });
    }
    case "channel.member_added":
    case "channel.member_removed": {
      const members = notice.params.members.map(memberName).join(", ");
      const actor = notice.params.actor
        ? memberName(notice.params.actor)
        : m.system_notice_actor_unknown({}, { locale });
      return notice.kind === "channel.member_added"
        ? m.system_notice_channel_member_added({ actor, members }, { locale })
        : m.system_notice_channel_member_removed({ actor, members }, { locale });
    }
    case "member.welcome_requested":
      return m.system_notice_member_welcome_requested({
        agent: mention(notice.params.agent),
        newcomer: shown(notice.params.newcomer),
      });
    case "agent_dm.chain_limit":
      return m.system_notice_agent_dm_chain_limit({}, { locale });
    case "agent_dm.rate_limit":
      return m.system_notice_agent_dm_rate_limit({}, { locale });
    case "legacy_text":
      return "";
  }
}

/**
 * A notice as the viewer reads it: rendered from its kind in the viewer's language, opening with
 * the emoji the server's text uses. A message with no structured content, a `legacy_text` one or
 * one whose params do not check out reads as its stored body.
 */
export function systemNoticeText(message: SystemNoticeSource, locale?: Locale): string {
  const notice = systemNoticeOf(message);
  const text = notice ? noticeText(notice, locale) : "";
  if (!text) return message.body;
  const emoji = notice && KIND_EMOJI[notice.kind];
  return emoji ? `${emoji} ${text}` : text;
}

/** A person a notice names, with the text a plain notice writes for them. */
export type NoticePerson = { person: SystemPerson & { kind?: string }; text: string };

/** Stands in for a person while the notice is split around them. */
const MARK = "\u0000";

/**
 * The notice as `systemNoticeText` reads, split at the people it names, so the row draws each one's
 * face before their name (Frank, 11-04, task #521). The words are the same: each person keeps the
 * text a plain notice writes for them.
 */
export function systemNoticeParts(
  message: SystemNoticeSource,
  locale?: Locale,
): (string | NoticePerson)[] {
  const people: NoticePerson[] = [];
  const marked =
    <P extends SystemPerson>(text: (person: P) => string) =>
    (person: P) => {
      people.push({ person, text: text(person) });
      return `${MARK}${people.length - 1}${MARK}`;
    };
  const notice = systemNoticeOf(message);
  const text = notice
    ? noticeText(notice, locale, {
        shown: marked(TEXT_NAMES.shown),
        memberName: marked(TEXT_NAMES.memberName),
        mention: marked(TEXT_NAMES.mention),
      })
    : "";
  if (!text) return [message.body];
  const emoji = notice && KIND_EMOJI[notice.kind];
  return (emoji ? `${emoji} ${text}` : text)
    .split(MARK)
    .map((part, index) => (index % 2 === 1 ? people[Number(part)]! : part))
    .filter((part) => part !== "");
}
