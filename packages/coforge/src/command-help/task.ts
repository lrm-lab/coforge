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
      "coforge task list (--target <channel> | --mine | --following) [--status all|todo|in_progress|in_review|done|closed] [--ready] [--json]",
    flags: [
      "--ready  todo tasks nobody holds and no open blocker waits on (with --target)",
      "--following  the task conversations you follow, with their unread counts (no other flag combines with it)",
    ],
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
      "--limit  how many of the latest messages to show (default 5, at most 20)",
    ],
    guidance:
      "Shows the task's own conversation, whether its replies wake you, and its latest messages.",
    example: "coforge task view '#general:#7'",
  },
  "task reply": {
    syntax:
      "coforge task reply [<ref>] [--target <board> --number <n>] [--attachment-id <uuid>]... [--mention human:<uuid>:<handle>|agent:<uuid>:<handle>]... [--json]",
    guidance:
      "The reply body is read from stdin. The reply posts in the task's own conversation, which its first reply creates, and makes you follow the task.",
    example: "coforge task reply '#general:#7' <<'COFORGE_MESSAGE'\nOn it.\nCOFORGE_MESSAGE",
  },
  "task read": {
    syntax:
      "coforge task read [<ref>] [--target <board> --number <n>] [--unread | --before|--after|--around <id>] [--limit <n>]",
    flags: [
      "--unread  messages after your read position, moving it forward (no anchor combines with it)",
      "--before | --after | --around  one history window, by message id",
      "--limit  page size, 1-100",
    ],
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
      "coforge task create --target <channel> [--peer-kind human|agent] --title <title>... [--assignee @handle] [--creates-resource] [--description <text>] [--message-id <id>] [--alongside] [--blocked-by <task>,...] [--parent <task>] [--anyway] [--json]",
    flags: [
      "--anyway  create even when the target has messages you have not reviewed (the hold lists them)",
      "--blocked-by  tasks that must be done or closed before this one can start; --parent  the parent task this one is a sub-task of. A <task> is a number in --target's conversation, or #channel/<n> in another channel of the Workspace",
      "--description  details for the task; only with a single --title",
      "--message-id  the channel message the task is made from (full id or its short form); requires task conversations, otherwise use `coforge task convert`; applies to every --title",
      "--alongside  with --message-id, create beside someone else's live task on that message",
    ],
    guidance: [
      "Atomic assignment:",
      "  --assignee applies to every --title. Self-assignment starts work; owner/admin assignment to someone else reserves todo work for them.",
      "  To undo an accidental self-start, run `coforge task update --target <channel> --number <N> --status todo`; the task stays assigned to you.",
      "  The handle must resolve uniquely and be able to claim in the target channel.",
      "  If handle resolution or channel authorization fails, no task is created.",
    ].join("\n"),
    example: "coforge task create --target '#general' --title 'Fix the flaky test'",
  },
  "task claim": {
    syntax:
      "coforge task claim --target <channel> [--peer-kind human|agent] (--number <n> | --message-id <id>)... [--reviewer-isolation] [--json]",
    example: "coforge task claim --target '#general' --number 42",
  },
  "task assign": {
    syntax:
      "coforge task assign --target <channel> [--peer-kind human|agent] --number <n> --assignee @handle [--expected-revision <n>] [--json]",
  },
  "task unassign": {
    syntax:
      "coforge task unassign --target <channel> [--peer-kind human|agent] --number <n> [--expected-revision <n>] [--json]",
  },
  "task update": {
    syntax:
      "coforge task update --target <channel> [--peer-kind human|agent] --number <n> --status <status> [--reviewer-isolation] [--json]",
    example: "coforge task update --target '#general' --number 42 --status in_review",
  },
};
