# `@lrm/coforge-anvil`

ANVIL (Agent-Neutral Vendor Interface Layer) owns the provider-neutral code-agent contract, runtime adapters and their shared execution machinery. The shared per-turn runner owns Session state, queued input, interrupts, identity reporting and turn processes; each provider supplies its native turn protocol.

The daemon supplies OS process trees and environment composition through explicit ports. Instructions, Skills, Git hooks, executable discovery, Workspace configuration, runtime inventory and caches remain host responsibilities. Anvil neither imports daemon implementations nor discovers executables or reads PATH.

The package is being populated incrementally from `packages/daemon/src/code-agent/`. Provider behavior and public contracts remain unchanged during the migration.

Import provider-neutral contracts and utilities from `@lrm/coforge-anvil`; embedded Pi runtime APIs are available only from `@lrm/coforge-anvil/pi`.
