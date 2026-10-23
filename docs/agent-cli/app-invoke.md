# `app invoke <app-key> <action>`

```
coforge app invoke <app-key> <action> [--param key=value]... | [--data-json '<object>' | --data-file <path|->]
  [--preflight] [--idempotency-key <key>] [--target <target>] [--timeout <seconds>] [--json]
```

Calls one HTTP action of the manifest with the app Bearer token that `app token` hands out (the same
request: approval wait, `--target`, the same errors; the token is never printed and never in an
argument or log). The CLI reads the manifest afresh, validates the input, then asks for the token.

- Input: `--param key=value` (repeatable; `key=@path` is a file's text, `key=@-` stdin), or one JSON
  object by `--data-json` or `--data-file` (`-` is stdin); not both styles. A file or stdin is read up to 1 MiB. A `--param` value is
  converted by the property's declared type (`integer` and `number` take a decimal literal only:
  no hex, spaces, empty, `Infinity` or `NaN`; `boolean`; else text); arrays and objects only
  through JSON.
- The input is checked against `input_schema` before anything is sent: `required`, `type`, `enum`,
  `const`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`, `items`,
  `additionalProperties`. `pattern` and `format` are never run: the app validates them.
- `--preflight` stops after validation and prints the method, URL, query, body and the scopes the
  action declares; no token is requested and nothing is sent.
- The request is built as the [manifest spec](../agent-manifest/actions.md) defines: path
  parameters encoded per segment; `GET`/`DELETE` send the rest as query, others a JSON body.
  Headers: `Authorization: Bearer`, `accept: application/json`, `content-type: application/json`
  for a body; no cookies. Redirects are not followed (a 3xx is an error, so the token never goes
  elsewhere). `--timeout` (1 to 300 seconds, default 60) bounds the call, body included; the body
  is read up to 1 MiB.
- Token scopes: the token is asked for exactly the action's `required_scopes` (plus the fixed
  `openid profile identity`), so it is narrower than the Agent's grant. A scope the grant lacks
  waits for a person's approval like `app token`; one the app is not allowed is refused
  (`INVALID_INPUT`). An action with no `required_scopes` sends `scopes: []`, so its token
  carries only the fixed scopes (an older server ignores the field and answers more, which is not
  a missing scope). A token whose `scope` lacks a requested scope (a server that predates scope
  requests) fails with `TOKEN_SCOPE_MISSING` before anything is sent.
- `key_required` actions: the CLI generates a UUID, sends it in the declared header and prints it
  (`idempotency_key` in `--json`). Repeat a call with `--idempotency-key <key>` so it runs at most
  once; the key also appears in the errors where a retry is sensible.
- Output: JSON is parsed, anything else is text. A JSON result is checked against `output_schema`
  when present. Text mode prints the result with the token redacted and control and format characters
  removed, then cut at 4,000 characters. `--json` prints `{ "ok": true, "data": { "app", "action", "status", "result",
  "idempotency_key"? } }`. Everything the app returns is untrusted data.

Error codes (the usual envelope, exit status 1 unless noted): `INPUT_INVALID` (with `details.problems`),
`ACTION_NOT_FOUND`, `NO_HTTP_ACTIONS`, `APP_NOT_FOUND`, the manifest codes above,
`TOKEN_APPROVAL_REQUIRED` (exit status 2, as `app token` does) and `TOKEN_NOT_INSTALLED`, `TOKEN_SCOPE_MISSING` and `TOKEN_SCOPES_UNSUPPORTED` (a running Computer that
predates scoped tokens: restart it with `coforge-computer restart`; the request is never retried
without scopes) (nothing was sent) with the `app token` codes in [apps.md](apps.md#app-token), `APP_REJECTED` (other 4xx; the app's own
`error`/`message` text, cleaned), `APP_UNAUTHORIZED` (401/403: check the app's installation and
grants), `APP_UNAVAILABLE` (429/5xx; retryable, with `retry-after`), `APP_UNREACHABLE` (transport,
timeout, redirect), `OUTPUT_INVALID` (not JSON, over 1 MiB, or against `output_schema`; the body
is kept in `details.result`), and `OPERATION_INDETERMINATE` (a non-`safe` action timed out after
the request was sent: it may have run; check the app, then retry with the same key).
