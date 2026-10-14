import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const directory = Bun.env.COFORGE_EVAL_DOCKER_RUNTIME_DIR || join(import.meta.dir, "build");
await mkdir(directory, { recursive: true });
for (const [entrypoint, name] of [
  [new URL("./task-worker.ts", import.meta.url).pathname, "task-worker.js"],
  [new URL("../../../../../packages/coforge/src/cli.ts", import.meta.url).pathname, "coforge-cli.js"],
]) {
  const result = await Bun.build({ entrypoints: [entrypoint], target: "bun" });
  if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${name}`);
  await Bun.write(join(directory, name), result.outputs[0]);
}
await Bun.write(join(directory, "coforge"), Bun.file(join(import.meta.dir, "coforge")));
await chmod(join(directory, "coforge"), 0o755);
console.log(`Docker Task runtime built in ${directory}`);
