import { readFile, readdir } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

// The Web image builds from a pruned checkout: its build stage copies only the workspace manifests
// it names. A `workspace:*` dependency of a copied manifest that is not itself copied fails
// `bun install --frozen-lockfile` inside the image - the lockfile lists the dependency, but no
// directory is on disk for it. No host check sees that class of bug, because a full checkout has
// every package: the Web staging deploy stayed broken for two days when `apps/web` gained its
// `@lrm/coforge-anvil` dependency without a matching COPY (packages/anvil).

const readManifest = async (directory: string) =>
  JSON.parse(
    await readFile(new URL(`../../${directory}/package.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

describe("Web image workspace closure", () => {
  test("the build stage copies every workspace its manifests reach", async () => {
    const dockerfile = await Bun.file(new URL("../../apps/web/Dockerfile", import.meta.url)).text();
    const buildStage = dockerfile.slice(0, dockerfile.indexOf(" AS migrate"));
    const copied = new Set(
      [...buildStage.matchAll(/^\s*COPY\s+(\S+)\/package\.json\s+\S+\s*$/gm)].map(
        (match) => match[1],
      ),
    );
    expect(copied.size).toBeGreaterThan(0);

    const { workspaces } = (await readManifest(".")) as { workspaces: string[] };
    const directories = new Map<string, string>();
    for (const pattern of workspaces) {
      const base = pattern.replace(/\/\*$/, "");
      for (const entry of await readdir(new URL(`../../${base}`, import.meta.url))) {
        const directory = `${base}/${entry}`;
        const manifest = await readManifest(directory).catch(() => undefined);
        if (typeof manifest?.name === "string") directories.set(manifest.name, directory);
      }
    }

    // The root manifest is copied too (as `package.json`), and bun enforces its `workspace:*`
    // dependencies the same way, so it is a start node with no directory of its own.
    const reachable = new Set<string>();
    const queue = [".", ...copied];
    while (queue.length > 0) {
      const directory = queue.pop() as string;
      if (reachable.has(directory)) continue;
      reachable.add(directory);
      const manifest = (await readManifest(directory)) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          if (!range.startsWith("workspace:")) continue;
          const dependency = directories.get(name);
          expect(
            dependency,
            `${directory} depends on ${name}, which has no workspace`,
          ).toBeDefined();
          if (dependency !== undefined && !copied.has(dependency)) queue.push(dependency);
        }
      }
    }

    expect(
      [...reachable].filter((directory) => directory !== "." && !copied.has(directory)),
    ).toEqual([]);
  });
});
