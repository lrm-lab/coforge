import { afterAll, mock } from "bun:test";

/**
 * `mock.module` for one test file. Bun's `mock.module` replaces a module for the rest of the
 * `bun test` process, and `mock.restore()` does not undo it. So a stub left in place breaks every
 * later file that tests the real module, and a stub carrying only a few exports breaks every later
 * importer of the others ("Export named … not found").
 *
 * This copies the real module's exports first, so anything `overrides` does not name stays real,
 * and puts the real module back in `afterAll`. Await it at the top level, before the code under
 * test is imported.
 */
export async function mockModuleForFile(
  path: string,
  overrides: () => Record<string, unknown>,
): Promise<void> {
  const real: Record<string, unknown> = { ...(await import(path)) };
  mock.module(path, () => ({ ...real, ...overrides() }));
  afterAll(() => {
    mock.module(path, () => real);
  });
}
