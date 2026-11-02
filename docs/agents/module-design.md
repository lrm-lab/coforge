# Module design and implementation discipline

Part of [the documentation index](../../README.md). The root [AGENTS.md](../../AGENTS.md) keeps the
rules; this page holds the examples and mechanics behind them.

## Owning module and seam

Treat `coforge-computer` and `coforge-daemon` as large, long-lived products. Before adding a feature,
identify its owning module and its public seam; do not put new business logic in the nearest command,
entrypoint, or transport file merely because it is convenient.

## Thin CLI commands

A command may parse arguments, invoke an application use case, and format the result for a human.
Workspace lookup, authentication, registration, runtime discovery, persistence, process supervision,
and protocol encoding belong to reusable modules below the command layer.

## Abstraction gradient

Upper layers express business intent (`setupComputer`, `registerComputer`, `startDaemonRuntime`);
middle layers coordinate domain operations (`getBySlug`, `buildRegistration`, `ensureStarted`); lower
layers expose implementation details (`encode`, `writeFrame`, `spawn`, `flush`). Do not create
cross-layer methods such as `findWorkspaceAndRegisterComputer` or `setupAndSendProtobufOverSocket`.

## Dependencies point downward

Entry points and commands may depend on application/domain modules; domain modules may depend on
ports/contracts; infrastructure modules implement those ports. Domain code must not import Commander,
terminal UI, filesystem paths, sockets, database clients, or provider-specific agent parsers.

## Names

Name modules after stable domain concepts and one responsibility. Prefer names such as
`WorkspaceCatalog`, `WorkspacePicker`, `ComputerRegistrar`, `RuntimeInventory`, `MachineIdentity`,
`CredentialStore`, and `AgentRuntimePool`. Avoid vague names such as `Helper`, `Utils`, `Service`,
`Resolver`, or `Manager` unless the name is an established domain role with a narrowly defined
responsibility.

## Imports

Import code in the same package through the `#src/` alias (`#src/code-agent/contract`), and a sibling
file through `./`. Do not write `../` into the package's own `src/`. Packages declare `#src/*` in their
`package.json` `imports` (Node subpath imports, so each package resolves its own alias even when another
package compiles its source); `apps/web` declares it only in `tsconfig.json` because it has `.tsx`
modules, never as a per-file `package.json` `imports` map. Web's type check applies that mapping to
package source it compiles, so a package `#src/x` must never name a file that also exists in
`apps/web/src` (`apps/web/test/import-alias-isolation.test.ts` enforces it). Another package is
imported by its package name (a `workspace:*` dependency, then the entry or a subpath). The
repository-root `scripts/` belong to no package, so `apps/*` and `packages/*` import them by relative
path. Scripts that run before `bun install` (staging `deploy` runs `validate-web-push-keys.ts`) keep
relative imports: package names need it.

## Terminology

Keep terminology consistent across code, protocol, logs, and documentation. Use one convention for each
concept; do not alternate between snake_case, camelCase, and arbitrary synonyms for the same public
field or event.

## Logging

Use the repository's logging framework directly. Configure its sinks and lifecycle once at the
application entry point, and obtain category loggers through the framework in owning modules. Do not
add a logger wrapper, adapter, facade, parallel low-level logger, or another abstraction layer over
capabilities the logging framework already provides.

## Module map

Keep a module map in the owning app's `AGENTS.md`: one line per module naming its directory and single
responsibility. Update it before reorganizing or adding a module. If the ownership or boundary is
unclear, stop and settle the design options before writing implementation code.

## Behavior changes

For behavior changes, establish the public module seam and regression test first. Test
application/domain behavior independently from CLI rendering, transport framing, and provider-specific
adapters.
