import pg from "pg";
import { dropScratchDatabase } from "../helpers/drop-scratch-database";

export type ScratchDatabase = { url: string; drop: () => Promise<void> };

export async function createMigratedScratchDatabase(
  baseUrl: string,
  prefix: string,
): Promise<ScratchDatabase> {
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const name = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const scratch = new URL(baseUrl);
  scratch.pathname = `/${name}`;
  const migrate = Bun.spawn([process.execPath, "x", "--bun", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: scratch.href },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await migrate.exited) !== 0) {
    const error = await new Response(migrate.stderr).text();
    await dropScratchDatabase(admin, name);
    await admin.end();
    throw new Error(`prisma migrate deploy failed for ${name}: ${error}`);
  }
  return {
    url: scratch.href,
    drop: async () => {
      await dropScratchDatabase(admin, name);
      await admin.end();
    },
  };
}
