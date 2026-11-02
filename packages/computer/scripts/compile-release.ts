// The Computer's release build: compiles the unified executable (management, Daemon and Agent
// modes in one binary) for one release target, with its version, feed and server inlined. The
// release scripts (scripts/release/publish.ts) call it; the target registry it compiles for is
// scripts/release/compile-targets.ts.
import { join, resolve } from "node:path";

import { resolveServerUrl } from "#src/release-channel";
import { zodResolvePlugin } from "../../../scripts/bun-resolve-zod-plugin";
import {
  isDarwinTarget,
  resolveBunCompileTarget,
  type ReleaseTarget,
} from "../../../scripts/release/compile-targets";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMPUTER_ENTRYPOINT = join(import.meta.dir, "../src/main.ts");

export type CompileTargetOptions = {
  target: ReleaseTarget;
  version: string;
  feedUrl: string;
  /** Directory the unified binary is written into; each target's compile call needs its
   * own directory or scratch file name to avoid two targets racing on the same output path. */
  outputDirectory: string;
  /** Signs a `darwin-*` output in place before its bytes are read, so every checksum computed
   * later is of the signed bytes. Never called for other targets; without it (local and test
   * builds) the output keeps Bun's ad-hoc signature. */
  sign?: (executable: string) => Promise<void>;
};

export type CompiledArtifacts = { computer: Uint8Array };

/** Cross-compiles the unified release binary for one target (test/release-executable.test.ts). */
export async function compileTargetArtifacts(
  options: CompileTargetOptions,
): Promise<CompiledArtifacts> {
  const bunTarget = resolveBunCompileTarget(options.target);
  const serverUrl = resolveServerUrl(options.feedUrl);
  const computer = await compileOne({
    entrypoint: COMPUTER_ENTRYPOINT,
    bunTarget,
    outfile: join(options.outputDirectory, `${options.target}-coforge-computer`),
    sign: isDarwinTarget(options.target) ? options.sign : undefined,
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
      "process.env.COFORGE_DAEMON_SERVER_URL": JSON.stringify(serverUrl),
    },
  });
  return { computer };
}

async function compileOne(options: {
  entrypoint: string;
  bunTarget: string;
  outfile: string;
  define: Record<string, string>;
  sign?: (executable: string) => Promise<void>;
}): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    compile: { target: options.bunTarget as Bun.Build.CompileTarget, outfile: options.outfile },
    // `main.ts` dispatches each role through a dynamic `import()`; split, each becomes a chunk
    // embedded in the executable and loaded at runtime (https://bun.com/docs/bundler/executables,
    // "Code splitting"), so an `__agent-cli` call no longer parses the Daemon and Computer code.
    // Measured on linux-x64: `coforge version` 0.40 s / 89 MB RSS unsplit, 0.09 s / 50 MB split.
    splitting: true,
    define: options.define,
    plugins: [zodResolvePlugin(REPO_ROOT)],
  });
  if (!result.success) {
    throw new Error(
      `bun build failed for ${options.entrypoint} (${options.bunTarget}): ${result.logs
        .map(String)
        .join("; ")}`,
    );
  }
  const output = result.outputs[0];
  if (!output) {
    throw new Error(
      `bun build produced no output for ${options.entrypoint} (${options.bunTarget})`,
    );
  }
  // Bun appends ".exe" to a windows compile target's outfile regardless of what extension was
  // requested, so the path actually written (output.path) is read back here rather than trusting
  // the outfile this function asked for.
  //
  // Signing rewrites the file, so it comes before the bytes are read.
  await options.sign?.(output.path);
  return new Uint8Array(await Bun.file(output.path).arrayBuffer());
}
