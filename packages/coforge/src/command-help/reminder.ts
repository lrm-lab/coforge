import type { HelpEntry } from "./entry";

export const reminderHelp: Readonly<Record<string, HelpEntry>> = {
  reminder: {
    syntax: "coforge reminder schedule|list|cancel|log|update|snooze|ack|dismiss|seal|unseal ...",
    example: "coforge reminder list --status scheduled,fired",
  },
  "reminder schedule": {
    syntax:
      "coforge reminder schedule --title <title> (--target <target>|--channel <target>) (--message-id <id>|--msg-id <id>) (--delay-seconds <n|duration>|--fire-at <iso>|--repeat <rule>) [--repeat <rule>] [--tz <zone>]",
    example:
      "coforge reminder schedule --title 'Check the deploy' --target '#general' --msg-id 01a1f2ec --delay-seconds 15m",
  },
  "reminder list": {
    syntax: "coforge reminder list [--all | --status scheduled,fired,canceled]",
    example: "coforge reminder list --status scheduled,fired",
  },
  "reminder cancel": {
    syntax: "coforge reminder cancel --id <id>",
    example: "coforge reminder cancel --id 01a1f2ec",
  },
  "reminder update": {
    syntax:
      "coforge reminder update --id <id> (--fire-at <iso>|--in <duration>|--title <title>|--cadence <rule|none>|--repeat <rule|none> [--tz <zone>])",
    example: "coforge reminder update --id 01a1f2ec --in 15m",
  },
  "reminder snooze": {
    syntax:
      "coforge reminder snooze --id <id> (--by <duration>|--delay-seconds <n|duration>|--fire-at <iso>)",
    example: "coforge reminder snooze --id 01a1f2ec --by 15m",
  },
  "reminder seal": {
    syntax:
      "coforge reminder seal --id <id> [--revision <n>|--all-pending] --owner <who> --until <condition>",
    example:
      "coforge reminder seal --id 123e4567 --all-pending --owner @ada --until 'the deploy lands'",
  },
  "reminder unseal": {
    syntax: "coforge reminder unseal --id <id> [--revision <n>|--all-pending]",
    example: "coforge reminder unseal --id 01a1f2ec --all-pending",
  },
  "reminder log": {
    syntax: "coforge reminder log --id <id>",
    example: "coforge reminder log --id 01a1f2ec",
  },
  "reminder ack": {
    syntax: "coforge reminder ack --id <id> --revision <n>",
    example: "coforge reminder ack --id 01a1f2ec --revision 3",
  },
  "reminder dismiss": {
    syntax: "coforge reminder dismiss --id <id> --revision <n>",
    example: "coforge reminder dismiss --id 01a1f2ec --revision 3",
  },
};
