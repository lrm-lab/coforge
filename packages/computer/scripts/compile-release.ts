// The Computer's release build: compiles the unified executable for one release target. The
// release scripts (scripts/release/publish.ts) call it; the target registry it compiles for is
// scripts/release/compile-targets.ts.
import { join } from "node:path";

import {
  isDarwinTarget,
  resolveBunCompileTarget,
  type ReleaseTarget,
} from "../../../scripts/release/compile-targets";
import type { DarwinReleaseSigner } from "../../../scripts/release/darwin-signing";
import { buildCliExecutable } from "../../coforge/scripts/build-executable";
import { buildComputerExecutable } from "./build-executable";

export type CompileTargetOptions = {
  target: ReleaseTarget;
  version: string;
  feedUrl: string;
  /** Directory the unified binary is written into; each target's compile call needs its
   * own directory or scratch file name to avoid two targets racing on the same output path. */
  outputDirectory: string;
  sign?: DarwinReleaseSigner;
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
  if (isDarwinTarget(options.target) && options.sign) {
    await options.sign(computerPath, "computer");
    await options.sign(cliPath, "cli");
  }
  return {
    computer: new Uint8Array(await Bun.file(computerPath).arrayBuffer()),
    cli: new Uint8Array(await Bun.file(cliPath).arrayBuffer()),
  };
}
