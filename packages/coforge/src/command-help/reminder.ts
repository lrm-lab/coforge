import type { HelpEntry } from "./entry";

export const reminderHelp: Readonly<Record<string, HelpEntry>> = {
  reminder: {
    syntax: "coforge reminder schedule|list|cancel|update|snooze|seal|unseal ...",
    example: "coforge reminder list",
  },
  "reminder schedule": {
    syntax:
      "coforge reminder schedule --title <title> --at <iso> [--repeat <rule>] [--target <target>] [--json]",
    example: "coforge reminder schedule --title 'Check the deploy' --at 2026-10-30T09:00:00Z",
  },
  "reminder list": {
    syntax: "coforge reminder list [--status scheduled|...] [--all] [--json]",
  },
  "reminder cancel": {
    syntax: "coforge reminder cancel --id <id> [--json]",
  },
  "reminder update": {
    syntax: "coforge reminder update --id <id> [--title <title>] [--at <iso>] [--json]",
  },
  "reminder snooze": {
    syntax: "coforge reminder snooze --id <id> --until <iso> [--json]",
  },
  "reminder seal": {
    syntax:
      "coforge reminder seal --id <id> [--revision <n>|--all-pending] --owner <who> --until <condition> [--json]",
    example:
      "coforge reminder seal --id 123e4567 --all-pending --owner @ada --until 'the deploy lands'",
  },
  "reminder unseal": {
    syntax: "coforge reminder unseal --id <id> [--revision <n>|--all-pending] [--json]",
  },
  "reminder log": {
    syntax: "coforge reminder log --id <id> [--json]",
  },
  "reminder ack": {
    syntax: "coforge reminder ack --id <id> --revision <n> [--json]",
  },
  "reminder dismiss": {
    syntax: "coforge reminder dismiss --id <id> --revision <n> [--json]",
  },
};
