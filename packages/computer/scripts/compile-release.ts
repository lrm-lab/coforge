// The Computer's release build: compiles the unified executable for one release target. The
// release scripts (scripts/release/publish.ts) call it; the target registry it compiles for is
// scripts/release/compile-targets.ts.
import { join } from "node:path";

import {
  isDarwinTarget,
  resolveBunCompileTarget,
  type ReleaseTarget,
} from "../../../scripts/release/compile-targets";
import { buildCliExecutable } from "../../coforge/scripts/build-executable";
import { buildComputerExecutable } from "./build-executable";

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

export type CompiledArtifacts = { computer: Uint8Array; cli: Uint8Array };

export async function compileTargetArtifacts(
  options: CompileTargetOptions,
): Promise<CompiledArtifacts> {
  const target = resolveBunCompileTarget(options.target) as Bun.Build.CompileTarget;
  const computerPath = await buildComputerExecutable({
    version: options.version,
    feedUrl: options.feedUrl,
    outfile: join(options.outputDirectory, `${options.target}-coforge-computer`),
    target,
  });
  const cliPath = await buildCliExecutable({
    version: options.version,
    outfile: join(options.outputDirectory, `${options.target}-coforge`),
    target,
  });
  // Signing rewrites the file, so it comes before the bytes are read.
  if (isDarwinTarget(options.target)) await options.sign?.(computerPath);
  return {
    computer: new Uint8Array(await Bun.file(computerPath).arrayBuffer()),
    cli: new Uint8Array(await Bun.file(cliPath).arrayBuffer()),
  };
}
