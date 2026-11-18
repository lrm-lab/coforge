import { expect, test } from "bun:test";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..");

const bundledScripts = async () => {
  const dockerfile = await Bun.file(join(webRoot, "Dockerfile")).text();
  const steps = dockerfile.replaceAll("\\\n", " ").split("\n");
  return steps
    .filter((line) => line.startsWith("RUN bun build apps/web/scripts/backfill-"))
    .filter((line) => !line.includes("--external"))
    .map((line) => line.split(" ")[3]!.replace("apps/web/", ""));
};

test("every backfill script the image bundles without externals builds as the image builds it", async () => {
  const scripts = await bundledScripts();
  expect(scripts.length).toBeGreaterThan(2);
  for (const script of scripts) {
    const built = await Bun.build({
      entrypoints: [join(webRoot, script)],
      target: "bun",
      throw: false,
    });
    expect({ script, errors: built.logs.filter((log) => log.level === "error") }).toEqual({
      script,
      errors: [],
    });
  }
});
