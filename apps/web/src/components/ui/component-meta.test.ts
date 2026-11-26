import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "bun:test";

import type { ComponentMeta } from "./component-meta";

const COMPONENTS_DIR = fileURLToPath(new URL("..", import.meta.url));

function findMetaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return findMetaFiles(full);
    return entry.name.endsWith(".meta.ts") ? [full] : [];
  });
}

test("every *.meta.ts file exports a valid ComponentMeta contract with unique names and faster exits", async () => {
  const files = findMetaFiles(COMPONENTS_DIR).sort();
  expect(files.length).toBeGreaterThanOrEqual(15);

  const seenComponents = new Set<string>();

  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const metas = Object.values(mod).filter(
      (value): value is ComponentMeta =>
        typeof value === "object" &&
        value !== null &&
        "component" in value &&
        "whenToUse" in value &&
        "whenNotToUse" in value,
    );

    const rel = relative(COMPONENTS_DIR, file);
    expect(metas.length, `${rel} must export at least one ComponentMeta`).toBeGreaterThan(0);

    for (const meta of metas) {
      expect(meta.component.trim().length, `${rel}: component name required`).toBeGreaterThan(0);
      expect(
        seenComponents.has(meta.component),
        `${rel}: duplicate component ${meta.component}`,
      ).toBe(false);
      seenComponents.add(meta.component);

      expect(meta.whenToUse.length, `${rel}: whenToUse cannot be empty`).toBeGreaterThan(0);
      expect(meta.whenNotToUse.length, `${rel}: whenNotToUse cannot be empty`).toBeGreaterThan(0);
      for (const misuse of meta.whenNotToUse) {
        expect(misuse.when.trim().length).toBeGreaterThan(0);
        expect(misuse.why.trim().length).toBeGreaterThan(0);
        expect(misuse.instead.trim().length).toBeGreaterThan(0);
      }

      if (meta.motion?.enterMs !== undefined && meta.motion?.exitMs !== undefined) {
        expect(
          meta.motion.exitMs,
          `${rel}: exitMs (${meta.motion.exitMs}) must be <= enterMs (${meta.motion.enterMs})`,
        ).toBeLessThanOrEqual(meta.motion.enterMs);
      }
    }
  }
});
