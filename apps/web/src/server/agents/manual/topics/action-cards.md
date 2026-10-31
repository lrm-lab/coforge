# Action cards

When a human should create a channel or Agent, or add members to a channel, do not do it
yourself and do not claim it already exists. Post a typed
action card instead: `coforge action prepare --target <target>` with a JSON body on stdin, for
example:

```
coforge action prepare --target "#general" <<'COFORGEACTION'
{"type":"channel:create","name":"design","visibility":"public"}
COFORGEACTION
```

Three kinds are supported:

- `channel:create` (`name`, `visibility` public or private, `description?`, `initialHumans?`,
  `initialAgents?`, `draftHint?`)
- `agent:create` (`name`, `description?`, `suggestedComputer?`, `requiredComputer?` — at most one
  of the two, `draftHint?`)
- `channel:add_member` (`channel`, `humans?`, `agents?` — at least one non-empty, `draftHint?`)

Identity references in an action card are handles, not UUIDs: `@alice`, `scout`, `#general`. The
server resolves each handle at prepare time; an unresolvable handle fails the command before
anything is posted.

Never prefill `runtime`, `model`, or `reasoning` on `agent:create`; those remain a human's choice.
Only set `requiredComputer` when the human explicitly said the new Agent must run on that
Computer; use `suggestedComputer` for a soft preference.

`"visibility": "private"` on `channel:create` makes a channel only its members can read.

`coforge action prepare` only records the card as a message in the target conversation for a
human to review; it does not create the channel, Agent, or membership itself. Do not say you
created, added, or configured anything until you have independent confirmation that a human
committed the card.

A human commits the card from chat, not from a command you send them: they click the card's
action button in the CoForge Web UI, review a form prefilled (and editable) from your card's
values, and submit it under their own identity. You cannot commit a card yourself and there is no
CLI command for it.

To check whether a card has been committed, read the card message again, for example
`coforge message read --target <target> --around <message-id>`. Its body ends with
`[action card: pending]`, `[action card: executed]`, or `[action card: cancelled]`. Only
`executed` means the channel, Agent, or membership now exists; `pending` means still waiting on a
human, and `cancelled` means it was dismissed and nothing was created. Do not claim the resource
exists on the strength of having posted the card alone.

## Filling a page

When a page on this Agent's computer needs something the person must type, such as a username
and password, post a `page:fill` card. Do not ask them to paste the value into chat, and do not
type it yourself.

Open the page in Chromium on this Agent's screen first. Every field needs a CSS selector. A
`password` field's selector must match an `input` whose type is `password`. There is no `value`
field. Example:

```
coforge action prepare --target "@owner" <<'COFORGEACTION'
{"type":"page:fill","prompt":"Sign in","fields":[{"id":"username","label":"Username","input":"text","selector":"#user"},{"id":"password","label":"Password","input":"password","selector":"input[type=password]"}]}
COFORGEACTION
```

The person types into the card. The values are written into the page and are not stored on the
card. Read the message again: `[action card: executed]` means the fields were filled. Then
continue, for example by submitting the form. `[action card: pending]` means they have not
filled it yet.
