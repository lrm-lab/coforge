import { join, resolve } from "node:path";

import { zodResolvePlugin } from "../../../scripts/bun-resolve-zod-plugin";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_ENTRYPOINT = join(import.meta.dir, "../src/cli.ts");

export type CliExecutableOptions = {
  version: string;
  outfile: string;
  target?: Bun.Build.CompileTarget;
};

export async function buildCliExecutable(options: CliExecutableOptions): Promise<string> {
  const result = await Bun.build({
    entrypoints: [CLI_ENTRYPOINT],
    compile: options.target
      ? { target: options.target, outfile: options.outfile }
      : { outfile: options.outfile },
    define: { "Bun.env.COFORGE_CLI_VERSION": JSON.stringify(options.version) },
    plugins: [zodResolvePlugin(REPO_ROOT)],
  });
  const target = options.target ?? "host";
  if (!result.success) {
    throw new Error(
      `bun build failed for ${CLI_ENTRYPOINT} (${target}): ${result.logs.map(String).join("; ")}`,
    );
  }
  const output = result.outputs[0];
  if (!output) throw new Error(`bun build produced no output for ${CLI_ENTRYPOINT} (${target})`);
  return output.path;
}
