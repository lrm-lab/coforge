# Anvil instructions

`@lrm/coforge-anvil` is the provider-neutral Agent interface library. Keep it independent of daemon runtime orchestration, platform implementations, filesystem state, transports, and provider-specific adapters.

- Public contracts and exports belong here; daemon imports them by package name.
- OS process trees and executable discovery are ports. The daemon supplies implementations explicitly; Anvil must not construct a platform default.
- Preserve provider behavior while migrating one contract or runtime slice at a time. Run the package checks and the daemon checks for every slice.
