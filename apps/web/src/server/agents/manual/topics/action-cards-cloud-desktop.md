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
card. When they confirm, you are woken with which fields were filled — continue, for example by
submitting the form. You can also re-read the message: `[action card: executed]` means the
fields were filled; `[action card: pending]` means they have not filled it yet.

## Opening the cloud desktop

When `page:fill` cannot finish the step (OAuth, captcha, unknown selectors, or the person asks
to type themselves), post a `desktop:takeover` card instead of asking for secrets in chat:

```
coforge action prepare --target "@owner" <<'COFORGEACTION'
{"type":"desktop:takeover","prompt":"Finish GitHub sign-in on the cloud desktop"}
COFORGEACTION
```

The person opens your screen from the card, finishes the step, then marks it done — you are
woken when they do. Prefer `page:fill` first; use takeover only when fill will not work.
