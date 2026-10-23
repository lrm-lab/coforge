# Examples

## `http_api`

```json
{
  "schema": "coforge-agent-manifest.v1",
  "name": "Acme Notes",
  "description": "The team's notes.",
  "docs_url": "https://notes.acme.example/docs",
  "execution": { "mode": "http_api", "base_url": "https://notes.acme.example/api" },
  "auth": { "type": "login_with_coforge" },
  "actions": [
    {
      "name": "notes.get",
      "description": "Read one note.",
      "effect": "read",
      "endpoint": { "method": "GET", "path": "/notes/{id}" },
      "idempotency": "safe",
      "required_scopes": ["notes:read"],
      "input_schema": {
        "type": "object",
        "properties": { "id": { "type": "string", "minLength": 1 } },
        "required": ["id"],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "body": { "type": "string" } }
      }
    },
    {
      "name": "notes.create",
      "description": "Create a note.",
      "effect": "create",
      "endpoint": { "method": "POST", "path": "/notes" },
      "idempotency": "key_required",
      "idempotency_header": "Idempotency-Key",
      "required_scopes": ["notes:read", "notes:write"],
      "input_schema": {
        "type": "object",
        "properties": { "title": { "type": "string", "maxLength": 200 } },
        "required": ["title"]
      }
    }
  ]
}
```

## `local_cli`

```json
{
  "schema": "coforge-agent-manifest.v1",
  "name": "Acme Notes CLI",
  "docs_url": "https://notes.acme.example/docs/cli",
  "execution": { "mode": "local_cli", "command": "acme-notes" },
  "credential_boundary": { "storage": "per_agent_home", "forbid_user_home": true }
}
```
