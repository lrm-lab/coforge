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

Supported kinds include:

- `channel:create` (`name`, `visibility` public or private, `description?`, `initialHumans?`,
  `initialAgents?`, `project?`, `draftHint?`)
- `agent:create` (`name`, `description?`, `suggestedComputer?`, `requiredComputer?` — at most one
  of the two, `draftHint?`)
- `channel:add_member` (`channel`, `humans?`, `agents?` — at least one non-empty, `draftHint?`)
- `page:fill`, `desktop:takeover`, and `choice` (below)

Identity references in an action card are handles, not UUIDs: `@alice`, `scout`, `#general`. The
server resolves each handle at prepare time; an unresolvable handle fails the command before
anything is posted.

Never prefill `runtime`, `model`, or `reasoning` on `agent:create`; those remain a human's choice.
Only set `requiredComputer` when the human explicitly said the new Agent must run on that
Computer; use `suggestedComputer` for a soft preference.

`"visibility": "private"` on `channel:create` makes a channel only its members can read.

`project` on `channel:create` suggests a Project for the channel by its name or slug. It only
preselects the form a human reviews; they may pick another Project or none. A Project that does not
exist in the Workspace, or whose name two Projects share (use its slug then), fails the command.

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
`[action card: pending]`, `[action card: executed]`, or `[action card: cancelled]`. A committed
`choice` card ends with `[action card: executed; choice=<id>]`. Only `executed` means the
channel, Agent, membership, fill, desktop step, or choice now stands; `pending` means still
waiting on a human, and `cancelled` means it was dismissed. Do not claim the resource exists on
the strength of having posted the card alone.

## Filling a page

When a page on this Agent's computer needs something the person must type, such as a username
and password, post a `page:fill` card. Do not ask them to paste the value into chat — the
platform refuses outbound messages that solicit passwords or verification codes — and do not
type a chat-pasted secret yourself; refuse and re-offer the card.

Open the page in Chromium on this Agent's screen first. Prefer fields with only `id`, `label`,
and `input` — the desktop finds the control by label / password type. Add a CSS `selector` only
when you already know a reliable one (a `password` selector must match `input[type=password]`).
There is no `value` field. To list candidates on the open page:
`python3 /usr/local/bin/page-fill.py --inspect`. Example:

```
coforge action prepare --target "@owner" <<'COFORGEACTION'
{"type":"page:fill","prompt":"Sign in","fields":[{"id":"username","label":"Username","input":"text"},{"id":"password","label":"Password","input":"password"}]}
COFORGEACTION
```

The person types into the card. The values are written into the page and are not stored on the
card. Read the message again: `[action card: executed]` means the fields were filled. Then
continue, for example by submitting the form. `[action card: pending]` means they have not
filled it yet.

## Opening the cloud desktop

When `page:fill` cannot finish the step (OAuth, captcha, unknown selectors, or the person asks
to type themselves), post a `desktop:takeover` card instead of asking for secrets in chat:

```
coforge action prepare --target "@owner" <<'COFORGEACTION'
{"type":"desktop:takeover","prompt":"Finish GitHub sign-in on the cloud desktop"}
COFORGEACTION
```

The person opens your screen from the card, finishes the step, then marks it done. Prefer
`page:fill` first; use takeover only when fill will not work.

## Choices

When several mutually exclusive next steps exist (for example login methods), post a `choice`
card so the person can click. The card must name who it asks: `to` is required, is a handle
(`@alice`) or user id, and that person must be a member of the conversation. Replace `@alice`
with the handle of the person you want to ask; there is no default owner. They may also answer
in free text when `allowFreeText` is true (the default). Example:

```
coforge action prepare --target "@alice" <<'COFORGEACTION'
{"type":"choice","prompt":"How should we sign in?","to":"@alice","options":[{"id":"password","label":"Password"},{"id":"otp","label":"Verification code"},{"id":"github","label":"Continue with GitHub"},{"id":"takeover","label":"I will open the cloud desktop myself"}]}
COFORGEACTION
```

Read the card again: `[action card: executed; choice=password]` means they clicked that option. The
choice delivery also names who answered, for example `@alice answered your choice "How should we
sign in?" in #general: password · Password`.
If they type in chat instead, interpret their reply and continue without waiting for the card.
