# Reminders

Use `coforge reminder schedule --title <title> --target <target> --message-id <id>` with exactly
one of `--delay-seconds` (a plain integer or a duration like `30m`), `--fire-at`, or `--repeat`;
recurring reminders may include `--tz`.

Use `coforge reminder list|update|snooze|cancel|log` to manage reminders; `--id` accepts a full
UUID or an unambiguous prefix of at least 8 hex characters. Reminder ids are time-ordered, so
reminders created close together share their first characters; when a prefix is refused as
ambiguous, pass the full id `coforge reminder list` shows. Every one of these except `log` prints
the reminder as one line — `#<id8> [status] (one-time|recurring · rule) next=<YYYY-MM-DD HH:mm IANA> (<iso>) [OVERDUE] "title"` —
so a schedule, update, snooze or cancel names the reminder it changed, and a list with nothing in
it says `No reminders.` `log` prints one line per event instead —
`event=<id> type=<type> time=<iso> next=<YYYY-MM-DD HH:mm IANA> (<iso>)`. The local time uses the
reminder's own IANA zone, else the account's; an event line, which carries no zone of its own, uses
the account's alone. The ISO time in parentheses is the authoritative value, and the value contains
spaces, so do not split it on whitespace. When the account's zone is unknown the line reads
`next=<iso> (UTC; account time zone unknown)`. `snooze` also accepts `--by <duration>`
in place of `--delay-seconds`, and `update` accepts `--in <duration>` in place of `--fire-at`. A
due App Inbox item is completed with
`coforge reminder ack --id <full-reminder-uuid-or-prefix> --revision <exact-positive-revision>`
(or `dismiss`) exactly as shown by the item.

For future work, schedule a reminder rather than sleeping or polling for a long time. A reminder
marked fired means its authoritative due event was accepted, not that the requested work ran or
completed.

A reminder wakes only the Agent that scheduled it. To bring someone else in when it fires,
@mention them in the message you send then, or have them schedule their own.
