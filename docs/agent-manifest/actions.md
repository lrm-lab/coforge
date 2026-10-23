# Actions and schemas

An `http_api` manifest lists its actions in `actions` (at most 64, names unique).

| Field                | Required       | Meaning                                                                |
| -------------------- | -------------- | ---------------------------------------------------------------------- |
| `name`               | yes            | `^[A-Za-z0-9._:-]{1,80}$`                                              |
| `description`        | no             | 1 to 500 characters                                                    |
| `effect`             | yes            | `read`, `create`, `update`, `delete` or `external_side_effect`         |
| `endpoint`           | yes            | `{ "method": GET/POST/PUT/PATCH/DELETE, "path": "/..." }`              |
| `idempotency`        | yes            | `safe`, `idempotent`, `key_required` or `non_idempotent`               |
| `idempotency_header` | `key_required` | HTTP header name carrying the key; allowed only with `key_required`    |
| `required_scopes`    | yes            | Unique, sorted Login with CoForge scopes: any of `email`, `identity`, `openid`, `profile` |
| `input_schema`       | yes            | Schema subset; root `type` is `object`                                 |
| `output_schema`      | no             | Schema subset                                                          |

## Scopes

`required_scopes` are Login with CoForge scopes (the SDK's `APP_SCOPES`), not scopes the app
invents; `openid`, `profile` and `identity` are fixed and every token has them. `coforge app
invoke` asks for a token of exactly these scopes, so each must also be among the app's allowed
scopes (else the token request is refused `INVALID_INPUT`, `app-scope-not-allowed`). What the app
lets the Agent do with the token is the app's own business.

## Endpoint path

Starts with `/` but not `//`; only URL path characters and `{param}` placeholders (no query,
fragment, credentials, whitespace). `/` alone names the base URL itself. Otherwise no empty
segments (so no trailing `/`), no `.` or `..` segments (also percent-encoded), valid
percent-encoding, and no encoded separators (`%2F`, `%5C`). A
`{param}` is a whole segment (`/notes/{id}`, never `/n-{id}`) with a name matching
`[A-Za-z_][A-Za-z0-9_]*` and balanced braces. Every `{param}` must be a **required** `string`,
`integer`, `number` or `boolean` property of `input_schema`.

## How the input reaches the request

The SDK's `buildActionRequest(action, input)` is the one implementation; callers do not redo it.

- Each `{name}` takes the same-named input property, converted to text and percent-encoded for that
  segment with `encodeURIComponent`, never inserted raw. A value that is empty, `.` or `..` is
  refused. The parameter is consumed: it is not repeated in the query or body.
- `GET` and `DELETE`: the remaining top-level input properties go to the query string. A scalar is
  one `name=value` pair, an array of scalars repeats the name, `null` is left out, and an object or
  nested array is refused.
- `POST`, `PUT` and `PATCH`: the remaining top-level properties form a JSON object body (`{}` when
  none remain).
- The idempotency key, when the action needs one, travels in `idempotency_header`, which may not be
  a credential or hop-by-hop header (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
  `host`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`,
  `keep-alive`) or any `x-coforge-*` name, in any letter case.

## Coherence

- A `GET` action has effect `read`; effect `read` requires method `GET` and idempotency `safe`.
- Effect `delete` requires method `DELETE`.
- Only `read` may be `safe`.

## Schema subset

`input_schema` and `output_schema` use a bounded subset of JSON Schema. Allowed keywords: `type`
(`string`, `integer`, `number`, `boolean`, `object`, `array`, `null`), `properties`, `required`
(unique names, each a declared property), `items`, `enum`, `const`, `description`, `title`,
`minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, `format`,
`additionalProperties` (boolean only) and `default`. `const` and `default` take a string, number,
boolean or null; `enum` has 1 to 64 such values. Anything else (`$ref`, `oneOf`, `allOf`, ...) is
rejected. At most 12 levels deep, 256 nodes and 128 properties per object; property names are 1 to
80 characters and may not be `__proto__`, `constructor` or `prototype`. `x-` keys are ignored.

`pattern` is at most 256 characters and compiles with the `u` flag. It is descriptive, for the Agent
reading the schema: CoForge never executes a manifest-supplied pattern, and the app validates its
own input.
