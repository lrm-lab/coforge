import type { HelpEntry } from "./entry";

/** The `task` family's help: the board commands, the conversation commands and their flags. */
export const taskHelp: Readonly<Record<string, HelpEntry>> = {
  task: {
    syntax:
      "coforge task list|show|view|reply|read|follow|unfollow|create|claim|assign|unassign|convert|unclaim|update|amend|history|delete|receipt ...",
    example: "coforge task list --target '#general'",
  },
  "task list": {
    syntax:
      "coforge task list (--target <channel> | --mine | --following) [--status all|backlog|todo|in_progress|done|closed (or several, comma-separated)] [--ready] [--label <name>]... [--json]",
    flags: [
      "--label  only tasks carrying every named label (repeatable)",
      "--ready  todo tasks nobody holds and no open blocker waits on (with --target)",
      "--following  the task conversations you follow, with their unread counts (no other flag combines with it)",
      "--status  all|backlog|todo|in_progress|done|closed (--mine defaults to unfinished, leaving backlog out)",
    ],
    guidance:
      "Tasks are listed highest priority first (prio=urgent, high, medium, low, none), then earliest due first (a task with no due waits behind dated ones of its level), oldest first within that. --mine leads with 'Your queue': the tasks that can start now (todo/in_progress, unblocked) numbered from 1; each row's queue=N is its place in the full queue even under --status or --label filters. A row's due= field marks (overdue) and (due soon).",
    example: "coforge task list --mine",
  },
  "task show": {
    syntax: "coforge task show --target <board> --number <n> [--peer-kind human|agent] [--json]",
    flags: [
      "--target  the board ('#channel' or '@peer') containing the task",
      "--peer-kind  for a direct @peer target, whether the peer is human or Agent",
      "--number  the task number",
    ],
    guidance:
      "Reads one task's title, description, Blocked by, Blocking, Parent task and Sub-tasks.",
    example: "coforge task show --target '#general' --number 7",
  },
  "task view": {
    syntax: "coforge task view [<ref>] [--target <board> --number <n>] [--limit <n>]",
    flags: [
      "<ref>  the task: '#channel:#7', or 'dm:@peer:#7' for a task in a DM; quote it, an unquoted # starts a shell comment",
      "--target, --number  the board ('#channel' or 'dm:@peer') and the task's number, instead of the ref",
      "--limit  how many of the latest entries to show, messages and history events together (default 5, at most 20)",
    ],
    guidance:
      "Shows the task's own conversation, whether its replies wake you, and its latest entries: the messages and the task's history events (status, assignee, priority, due, label, project, blocker and parent changes; a description change shows only that it was updated) as one stream, oldest first.",
    example: "coforge task view '#general:#7'",
  },
  "task reply": {
    syntax:
      "coforge task reply [<ref>] [--target <board> --number <n>] [--attachment-id <uuid>]... [--mention human:<uuid>:<handle>|agent:<uuid>:<handle>]... [--json]",
    guidance:
      "The reply body is read from stdin. The reply posts in the task's own conversation and makes you follow the task.",
    example: "coforge task reply '#general:#7' <<'COFORGE_MESSAGE'\nOn it.\nCOFORGE_MESSAGE",
  },
  "task read": {
    syntax:
      "coforge task read [<ref>] [--target <board> --number <n>] [--unread | --before|--after|--around <id>] [--limit <n>] [--confirm-delivery | --peek] [--confirm <JSON>]",
    flags: [
      "--unread  messages after your read position, moving it forward (no anchor combines with it)",
      "--before | --after | --around  one history window, by message id",
      "--limit  page size, 1-100",
    ],
    guidance:
      "History events that fall in the window are listed among the messages (`- [event ...]` lines); each belongs to exactly one page.",
    example: "coforge task read '#general:#7' --unread",
  },
  "task follow": {
    syntax: "coforge task follow [<ref>] [--target <board> --number <n>]",
    guidance: "Following makes the task's replies wake you.",
    example: "coforge task follow '#general:#7'",
  },
  "task unfollow": {
    syntax: "coforge task unfollow [<ref>] [--target <board> --number <n>] [--reason <text>]",
    flags: ["--reason  why you stop, shown in the conversation (at most 200 characters)"],
    guidance:
      "Stops ordinary replies waking you. A later @mention, being assigned the task or claiming it follows it again; replying in it does too.",
    example: "coforge task unfollow '#general:#7'",
  },
  "task create": {
    syntax:
      "coforge task create --target <channel> --message-id <id> --title <title>... [--peer-kind human|agent] [--assignee @handle] [--status backlog|todo|in_progress] [--description <text>] [--blocked-by <task>,...] [--parent <task>] [--label <name>]... [--priority urgent|high|medium|low] [--due <date|datetime>] [--project <slug>] [--anyway] [--json]",
    flags: [
      "--message-id  required: the channel message that asked for the work (full or short id; a thread reply resolves to its thread's root). For your own idea, post a channel message first",
      "--status  starting status: backlog, todo, or in_progress (default: in_progress when assigning yourself, otherwise todo)",
      "--priority  urgent, high, medium or low (default: medium)",
      "--anyway  create even when the source thread has messages you have not reviewed (the hold lists them)",
      "--blocked-by  tasks that must be done or closed before this one can start; --parent  the parent task this one is a sub-task of. A <task> is a number in --target's conversation, or #channel/<n> in another channel of the Workspace",
      "--description  details for the task; only with a single --title",
      "--label  a Workspace label to attach (repeatable, at most five); the label must already exist",
      "--project  file the Task under this Project by slug (otherwise under no Project, or its parent's with --parent)",
      "--label-description  the description a label this command creates gets; without it an unknown label is refused",
      "--due  the due instant, a date like 2026-11-20 (local midnight) or a datetime; change or clear it later with `task amend --due|--clear-due`",
    ],
    guidance: [
      "Atomic assignment:",
      "  Self-assignment starts work (in_progress); assigning someone else reserves todo work (requires owner/admin). Applies to every --title.",
      "  --status overrides that: `--status todo --assignee @you` reserves it without starting; `--status backlog` parks it.",
      "  Undo a self-start: `coforge task update --target <channel> --number <N> --status todo`; the task stays assigned to you.",
      "  If handle resolution or channel authorization fails, no task is created.",
    ].join("\n"),
    example:
      "coforge task create --target '#general' --message-id abc12345 --title 'Fix the flaky test'",
  },
  "task claim": {
    syntax:
      "coforge task claim [<ref>] [--target <channel> --number <n>...] [--peer-kind human|agent] [--reviewer-isolation] [--json]",
    example: "coforge task claim '#general:#42'",
  },
  "task assign": {
    syntax:
      "coforge task assign [<ref>] [@handle] [--target <channel> --number <n>] [--assignee @handle] [--reason <text>] [--expected-revision <n>] [--peer-kind human|agent] [--json]",
    flags: [
      "--reason  handing the task to someone else: one line on what it waits on them for (max 500 characters; required from an Agent handing a task to someone else, refused when assigning yourself)",
    ],
    example: "coforge task assign '#general:#42' @alice --reason 'Ready for your review'",
  },
  "task unassign": {
    syntax:
      "coforge task unassign [<ref>] [--target <channel> --number <n>] [--peer-kind human|agent] [--expected-revision <n>] [--json]",
  },
  "task update": {
    syntax:
      "coforge task update [<ref>] [--target <channel> --number <n>] (--status backlog|todo|in_progress|done|closed [--reason <text>] | --priority <level> | --label <name> | --label -<name>) [--label-description <text>] [--reviewer-isolation] [--peer-kind human|agent] [--json]",
    flags: [
      "--status  backlog, todo, in_progress, done, or closed (any status can move to any other; in_review is retired and maps to in_progress)",
      "--reason  with --status backlog only: what would bring the task back (optional, max 500 characters)",
      "--priority  urgent, high, medium or low. People set any task's; an Agent only a task it created, or in a channel it coordinates",
      "--label  adds a label by name; --label -name takes one off (repeatable). --label-description lets an unknown label be created",
    ],
    example: "coforge task update '#general:#42' --status done",
  },
};
