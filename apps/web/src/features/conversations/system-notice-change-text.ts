import type { TaskName } from "@lrm/coforge-sdk/internal";
import { formatTaskDueForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale, type Locale } from "#src/paraglide/runtime";
import type { SystemNotice, SystemPerson, SystemTask } from "./system-notice";

type TaskChangeNotice = Extract<
  SystemNotice,
  {
    kind:
      | "task.due_changed"
      | "task.labels_changed"
      | "task.project_changed"
      | "task.parent_changed"
      | "task.dependencies_changed"
      | "task.amended";
  }
>;

const taskName = (name: TaskName, locale?: Locale) => {
  if (name.hidden)
    return name.deleted
      ? m.system_notice_task_hidden_deleted({}, { locale })
      : m.system_notice_task_hidden({}, { locale });
  const number = name.channel ? `${name.channel}:#${name.number}` : name.number;
  return m.system_notice_task_number({ number }, { locale });
};

const listed = (items: readonly string[], locale?: Locale) =>
  items.join(m.system_notice_list_separator({}, { locale }));

const dueShown = (at: string, locale?: Locale) =>
  formatTaskDueForDisplay(at, undefined, null, locale ?? getLocale());

export function taskChangeText(
  notice: TaskChangeNotice,
  {
    locale,
    shown,
    reference,
  }: {
    locale?: Locale;
    shown: (person: SystemPerson) => string;
    reference: (task: SystemTask) => string;
  },
): string {
  const task = reference(
    notice.kind === "task.amended" ? { ...notice.params.task, title: "" } : notice.params.task,
  );
  switch (notice.kind) {
    case "task.due_changed": {
      const { from, to } = notice.params;
      const actor = shown(notice.params.actor);
      if (!to) return m.system_notice_task_due_removed({ actor, task }, { locale });
      return from
        ? m.system_notice_task_due_changed(
            { actor, task, from: dueShown(from, locale), to: dueShown(to, locale) },
            { locale },
          )
        : m.system_notice_task_due_set({ actor, task, due: dueShown(to, locale) }, { locale });
    }
    case "task.labels_changed": {
      const added = listed(
        notice.params.added.map((label) => label.name),
        locale,
      );
      const removed = listed(
        notice.params.removed.map((label) => label.name),
        locale,
      );
      if (!notice.params.actor)
        return removed && !added
          ? m.system_notice_task_labels_merged({ task, removed }, { locale })
          : "";
      const actor = shown(notice.params.actor);
      if (added && removed)
        return m.system_notice_task_labels_changed({ actor, task, added, removed }, { locale });
      return added
        ? m.system_notice_task_labels_added({ actor, task, added }, { locale })
        : m.system_notice_task_labels_removed({ actor, task, removed }, { locale });
    }
    case "task.project_changed": {
      const { from, to } = notice.params;
      const actor = shown(notice.params.actor);
      if (!to)
        return from
          ? m.system_notice_task_project_removed({ actor, task, from: from.name }, { locale })
          : "";
      return from
        ? m.system_notice_task_project_changed(
            { actor, task, from: from.name, to: to.name },
            { locale },
          )
        : m.system_notice_task_project_set({ actor, task, to: to.name }, { locale });
    }
    case "task.parent_changed": {
      const { from, to } = notice.params;
      const actor = shown(notice.params.actor);
      if (!to)
        return from
          ? m.system_notice_task_parent_removed(
              { actor, task, from: taskName(from, locale) },
              { locale },
            )
          : "";
      return from
        ? m.system_notice_task_parent_changed(
            { actor, task, from: taskName(from, locale), to: taskName(to, locale) },
            { locale },
          )
        : m.system_notice_task_parent_set({ actor, task, to: taskName(to, locale) }, { locale });
    }
    case "task.dependencies_changed": {
      const actor = shown(notice.params.actor);
      const added = listed(
        notice.params.added.map((name) => taskName(name, locale)),
        locale,
      );
      const removed = listed(
        notice.params.removed.map((name) => taskName(name, locale)),
        locale,
      );
      if (added && removed)
        return m.system_notice_task_blockers_changed({ actor, task, added, removed }, { locale });
      if (added) return m.system_notice_task_blockers_added({ actor, task, added }, { locale });
      return removed
        ? m.system_notice_task_blockers_removed({ actor, task, removed }, { locale })
        : "";
    }
    case "task.amended": {
      const { title, description } = notice.params;
      const actor = shown(notice.params.actor);
      if (title && description)
        return m.system_notice_task_renamed_described(
          { actor, task, from: title.from, to: title.to },
          { locale },
        );
      if (title)
        return m.system_notice_task_renamed(
          { actor, task, from: title.from, to: title.to },
          { locale },
        );
      return description ? m.system_notice_task_described({ actor, task }, { locale }) : "";
    }
  }
}
