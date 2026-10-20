import { readFileSync } from "node:fs";
import { join } from "node:path";

const prismaDirectory = join(import.meta.dir, "../../prisma");

/**
 * The whole Prisma schema as text: `prisma/schema.prisma` and every `prisma/models/*.prisma`
 * domain file, the set Prisma loads from the `prisma` directory. A test that pins schema text
 * reads this, never one file, so it keeps covering a model wherever it lives.
 */
export function readPrismaSchema(): string {
  const files = [...new Bun.Glob("**/*.prisma").scanSync({ cwd: prismaDirectory })].sort();
  return files.map((file) => readFileSync(join(prismaDirectory, file), "utf8")).join("\n");
}
