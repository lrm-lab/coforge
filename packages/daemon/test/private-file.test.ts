import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePrivateFile } from "#src/platform/private-file";

test.skipIf(process.platform === "win32")(
  "writePrivateFile creates missing parents 0700 and writes the file 0600",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-private-file-"));
    try {
      const path = join(root, "a", "b", "unit.service");
      await writePrivateFile(path, "[Unit]\nDescription=é\n");
      expect(await readFile(path, "utf8")).toBe("[Unit]\nDescription=é\n");
      // The process umask can only clear bits, so 0700/0600 are the most a create can grant.
      expect((await stat(path)).mode & 0o777).toBe(0o600 & ~process.umask());
      expect((await stat(join(root, "a", "b"))).mode & 0o777).toBe(0o700 & ~process.umask());
      expect((await stat(join(root, "a"))).mode & 0o777).toBe(0o700 & ~process.umask());

      // A rewrite replaces the content.
      await writePrivateFile(path, "second");
      expect(await readFile(path, "utf8")).toBe("second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
