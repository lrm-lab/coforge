// The release target names this repository already uses across docs/release/, updater.ts's
// manifest.platforms keys and install.sh's/install.ps1's `uname`/architecture switch, mapped to
// the `Bun.build({ compile: { target } })` string that actually cross-compiles each one. Verified
// against Bun 1.4.0 by compiling this repository's own entrypoints for every target below and
// confirming a real ELF/PE binary for the right architecture came out (see the CR description);
// `bun-windows-arm64` in particular is easy to assume unsupported and is not.
//
// The darwin targets need Bun >= 1.4.2 (mise.lock pins it): earlier Bun wrote an invalid ad-hoc
// code signature into compiled executables (oven-sh/bun#32159). macOS 26 still ran them, but
// macOS 27 kills them at launch with SIGKILL / OS_REASON_CODESIGNING, so every published
// Computer built by an older Bun was dead on arrival there. release-executable.test.ts verifies
// the signature with `codesign --verify --strict` on macOS hosts.
const BUN_COMPILE_TARGETS = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
  "windows-arm64": "bun-windows-arm64",
} as const satisfies Record<string, `bun-${string}`>;

export type ReleaseTarget = keyof typeof BUN_COMPILE_TARGETS;

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return Object.hasOwn(BUN_COMPILE_TARGETS, value);
}

/** Whether the target's executable is a Mach-O one, the only kind that is signed. */
export function isDarwinTarget(target: string): boolean {
  return target.startsWith("darwin-");
}

/** Throws on an unsupported target instead of returning undefined, so a typo in a target name
 * fails at the call site instead of three files downstream as a manifest silently missing a
 * platform. */
export function resolveBunCompileTarget(
  target: string,
): (typeof BUN_COMPILE_TARGETS)[ReleaseTarget] {
  if (!isReleaseTarget(target)) {
    throw new Error(`unsupported release target: ${target}`);
  }
  return BUN_COMPILE_TARGETS[target];
}
