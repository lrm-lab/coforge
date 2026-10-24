# `@lrm/coforge-anvil`

ANVIL (Agent-Neutral Vendor Interface Layer) owns the provider-neutral code-agent contract and the runtime-facing utilities shared by code-agent adapters. It has no dependency on daemon platform implementations; operating-system process and executable discovery capabilities are supplied by the daemon through explicit ports.

The package is being populated incrementally from `packages/daemon/src/code-agent/`. Provider behavior and public contracts remain unchanged during the migration.
