// Builds the unified Computer executable (management, Daemon and Agent modes in one binary) with
// its version, feed and server inlined. Both builds share it: the release build
// (compile-release.ts) per release target, and the local `bun run build` (build.ts) for this host.
import { join, resolve } from "node:path";

import { resolveServerUrl } from "#src/release-channel";
import { zodResolvePlugin } from "../../../scripts/bun-resolve-zod-plugin";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMPUTER_ENTRYPOINT = join(import.meta.dir, "../src/main.ts");

export type ComputerExecutableOptions = {
  version: string;
  feedUrl: string;
  outfile: string;
  /** A Bun cross-compile target; omitted, the executable is built for this host. */
  target?: Bun.Build.CompileTarget;
};

/** Returns the path actually written: Bun appends ".exe" to a Windows executable's outfile
 * whatever extension was requested. */
export async function buildComputerExecutable(options: ComputerExecutableOptions): Promise<string> {
  const result = await Bun.build({
    entrypoints: [COMPUTER_ENTRYPOINT],
    // Bun rejects a `target` key that is present but undefined, so the host build omits it.
    compile: options.target
      ? { target: options.target, outfile: options.outfile }
      : { outfile: options.outfile },
    // `main.ts` dispatches each role through a dynamic `import()`; split, each becomes a chunk
    // embedded in the executable and loaded at runtime (https://bun.com/docs/bundler/executables,
    // "Code splitting"), so an `__agent-cli` call no longer parses the Daemon and Computer code.
    // Measured on linux-x64: `coforge version` 0.40 s / 89 MB RSS unsplit, 0.09 s / 50 MB split.
    splitting: true,
    // Bun.build()'s `env` option, verified against Bun 1.4.0, does inline a variable that is
    // actually set in the process running the build - but stays a *live runtime lookup* in the
    // compiled binary when that variable is unset at build time (the exact case the spec's
    // "runtime can still override it" concern describes: a build invoked without the variable
    // exported would silently keep resolving it at install time instead of failing to build).
    // `define` cannot degrade that way: it always inlines the literal given here, so a release
    // build can never accidentally ship a binary that still trusts whatever feed URL happens to
    // be in its environment at update time.
    define: {
      "process.env.COFORGE_RELEASE_FEED_URL": JSON.stringify(options.feedUrl),
      "process.env.COFORGE_E2E_ALLOW_DEVICE_AUTH": JSON.stringify("0"),
      "Bun.env.COFORGE_COMPUTER_VERSION": JSON.stringify(options.version),
      "process.env.COFORGE_DAEMON_VERSION": JSON.stringify(options.version),
      // The `__agent-cli` dispatch bundles `@lrm/coforge/runner` (packages/coforge/src/cli.ts)
      // into this same executable; `coforge version`/`coforge --version` need the real release
      // version inlined the same way, not the package.json fallback.
      "Bun.env.COFORGE_CLI_VERSION": JSON.stringify(options.version),
      "process.env.COFORGE_DAEMON_SERVER_URL": JSON.stringify(resolveServerUrl(options.feedUrl)),
    },
    plugins: [zodResolvePlugin(REPO_ROOT)],
  });
  const target = options.target ?? "host";
  if (!result.success) {
    throw new Error(
      `bun build failed for ${COMPUTER_ENTRYPOINT} (${target}): ${result.logs.map(String).join("; ")}`,
    );
  }
  const output = result.outputs[0];
  if (!output) {
    throw new Error(`bun build produced no output for ${COMPUTER_ENTRYPOINT} (${target})`);
  }
  return output.path;
}
