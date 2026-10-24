# Feature flags

A feature flag lets a feature ship to `main` dark and be turned on for chosen Workspaces before
everyone. The Web server evaluates flags with the [OpenFeature server SDK][openfeature] and the
official [flagd provider][flagd-provider] in its in-process, offline-file mode: flag definitions
are a [flagd flag definition file][flag-definitions] the server reads from disk, with targeting
rules in JSON Logic. There is no flagd service and no database table.

The code is `apps/web/src/server/feature-flags/`. Server code asks one question,
`isFeatureEnabled(flag, { workspaceId, workspaceSlug? })`, and never imports OpenFeature
itself. The answer is off unless the file turns the flag on. Two more seams serve a feature that needs setup
before its first use: `isFeatureDefined(flag)` (does the loaded file mark the flag ENABLED, whoever it targets) and
`onFeatureFlagsChanged(listener)` (the polled file was reloaded).

## Configuration

`COFORGE_FEATURE_FLAGS_FILE` is the path of the flag definition file, read once at boot by
`assertStartupConfig` (the `startup_config_checked` log line reports `feature_flags: configured`
or `disabled`).

- Unset or blank: no provider is installed and every flag is off. Production runs this way.
  Staging sets it: its definitions are the `coforge_feature_flags` config inlined in
  `infra/staging/docker-compose.yml` (write `$` as `$$` there), so they ship and roll back with
  that file; a change takes effect on the next staging deploy.
- Set: the file must exist and pass flagd's flag definition schema, or the boot fails with an
  error naming the variable. The check is stricter than the provider, which would load a file
  whose targeting rule is misspelt and only log it. A misspelt property name, such as
  `targetting`, is not a schema error: the flag loads and the rule is silently absent.

The provider polls the file (about every five seconds), so an edit applies without a restart. A
later edit that does not parse logs `feature_flags:provider_error` and the previous definitions stay in
force; only the boot validates strictly, so check an edit before relying on it.

## Evaluation context

Each evaluation passes the Workspace as the OpenFeature targeting key, plus named attributes a
rule can read with `{ "var": ... }`:

| Variable        | Value                                   |
| --------------- | --------------------------------------- |
| `targetingKey`  | the Workspace id                        |
| `workspaceSlug` | the Workspace's slug, when known        |

flagd also provides `$flagd.flagKey` and `$flagd.timestamp`.

A flag the file does not define, a disabled flag, and any evaluation error all evaluate to off.
An evaluation error is logged once per flag and error code as
`feature_flags:evaluation_failed`, with the flag, the error code and the Workspace id.

## Turning a flag on for one Workspace

Write a file such as `feature-flags.json` and point the variable at it:

```json
{
  "$schema": "https://flagd.dev/schema/v0/flags.json",
  "flags": {
    "app-data-permissions": {
      "state": "ENABLED",
      "variants": { "on": true, "off": false },
      "defaultVariant": "off",
      "targeting": {
        "if": [{ "in": [{ "var": "workspaceSlug" }, ["frank"]] }, "on", "off"]
      }
    }
  }
}
```

```sh
COFORGE_FEATURE_FLAGS_FILE=./feature-flags.json
```

- More Workspaces: add slugs to the list. A slug can change; to pin a Workspace for good, match
  its id instead: `{ "in": [{ "var": "targetingKey" }, ["<workspace id>"]] }`.
- On for everyone: drop `targeting` and set `"defaultVariant": "on"`.
- Off again: set `"state": "DISABLED"`, or remove the flag.

Every flag is boolean, with the variants `on` and `off` and `off` as the default variant.

## The flag registry

`FEATURE_FLAGS` in `apps/web/src/server/feature-flags/feature-flags.server.ts` lists every flag
the server may evaluate, each with one line on what it gates; `isFeatureEnabled` accepts only
those keys.

- One flag per feature. Name it after the feature in kebab-case (`app-data-permissions`).
- Add a flag in the slice that gates its feature, with the code that reads it.
- Once the feature is on everywhere, delete the flag in one change: the registry entry, every
  `isFeatureEnabled` call site and the code path it switched off, the tests that set it, and every
  assertion that names it. Grep the implementation, the tests and the assertions for the key;
  then remove it from any deployed flag file.

## Sources

- [OpenFeature JavaScript server SDK][openfeature]
- [flagd provider for JavaScript][flagd-provider] (in-process resolver, `offlineFlagSourcePath`)
- [flagd flag definitions][flag-definitions], including targeting rules

[openfeature]: https://openfeature.dev/docs/reference/technologies/server/javascript/
[flagd-provider]: https://github.com/open-feature/js-sdk-contrib/tree/main/libs/providers/flagd
[flag-definitions]: https://flagd.dev/reference/flag-definitions/
