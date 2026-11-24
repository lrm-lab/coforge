import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { dropScratchDatabase } from "../helpers/drop-scratch-database";

export type ScratchDatabase = { url: string; drop: () => Promise<void> };

export const SCRATCH_DATABASE_TEMPLATE_ENV = "COFORGE_SCRATCH_DATABASE_TEMPLATE";
export const SCRATCH_DATABASE_TEMPLATE_BASE_URL_ENV = "COFORGE_SCRATCH_DATABASE_TEMPLATE_BASE_URL";
export const SCRATCH_DATABASE_CREATED_FILE_ENV = "COFORGE_SCRATCH_DATABASE_CREATED_FILE";

const DATABASE_NAME = /^[a-z0-9_]{1,63}$/;
const PG_SQLSTATE = /^[0-9A-Z]{5}$/;
const CANCEL_CREATE_WAIT_MS = 5_000;
const CANCEL_BACKEND_WAIT_MS = 2_000;
const WEB_DIR = join(import.meta.dir, "../..");

function destroyPgClientStream(client: pg.PoolClient): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } })
    .connection?.stream;
  stream?.destroy?.();
}

function assertDatabaseName(name: string): string {
  if (!DATABASE_NAME.test(name)) {
    throw new Error(`Invalid scratch database name: ${JSON.stringify(name)}`);
  }
  return name;
}

function hasPgErrorCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    PG_SQLSTATE.test((error as { code: string }).code)
  );
}

function normalizeScheme(protocol: string): string {
  return protocol === "postgres:" ? "postgresql:" : protocol;
}

function sameDatabaseAuthority(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      normalizeScheme(a.protocol) === normalizeScheme(b.protocol) &&
      a.hostname === b.hostname &&
      (a.port || "5432") === (b.port || "5432") &&
      a.username === b.username
    );
  } catch {
    return false;
  }
}

function configuredTemplateFor(baseUrl: string): string | undefined {
  const name = process.env[SCRATCH_DATABASE_TEMPLATE_ENV]?.trim();
  if (!name) return undefined;
  const templateBaseUrl = process.env[SCRATCH_DATABASE_TEMPLATE_BASE_URL_ENV]?.trim();
  if (!templateBaseUrl) return undefined;
  if (!sameDatabaseAuthority(baseUrl, templateBaseUrl)) return undefined;
  return assertDatabaseName(name);
}

function recordCreatedDatabase(createdFile: string | undefined, name: string): void {
  if (createdFile) appendFileSync(createdFile, `+${name}\n`, "utf8");
}

function recordDroppedDatabase(createdFile: string | undefined, name: string): void {
  if (createdFile) appendFileSync(createdFile, `-${name}\n`, "utf8");
}

function parseActiveRegistryEntries(raw: string): string[] {
  const active = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("+")) {
      active.add(assertDatabaseName(trimmed.slice(1)));
    } else if (trimmed.startsWith("-")) {
      active.delete(assertDatabaseName(trimmed.slice(1)));
    } else {
      active.add(assertDatabaseName(trimmed));
    }
  }
  return [...active];
}

async function waitForNoConnections(admin: pg.Pool, database: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ open: number }>(
      `SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1`,
      [database],
    );
    if (rows[0]?.open === 0) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for connections to close on ${database}`);
}

type MigrateSignalControl = {
  onSpawn: (proc: ReturnType<typeof Bun.spawn>) => void;
  onExit: () => void;
  getReceivedSignal: () => NodeJS.Signals | undefined;
};

async function migrateScratchDatabase(
  databaseUrl: string,
  name: string,
  signalControl?: MigrateSignalControl,
): Promise<void> {
  const migrate = Bun.spawn([process.execPath, "x", "--bun", "prisma", "migrate", "deploy"], {
    cwd: WEB_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: "ignore",
    stderr: "pipe",
  });
  let localSignal: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals) => {
    localSignal = signal;
    migrate.kill(signal);
  };
  if (signalControl) {
    signalControl.onSpawn(migrate);
  } else {
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
  }
  try {
    const exitCode = await migrate.exited;
    const receivedSignal = signalControl ? signalControl.getReceivedSignal() : localSignal;
    if (receivedSignal) {
      throw new Error(`prisma migrate deploy interrupted by ${receivedSignal} for ${name}`);
    }
    if (exitCode !== 0) {
      const error = await new Response(migrate.stderr).text();
      throw new Error(`prisma migrate deploy failed for ${name}: ${error}`);
    }
  } finally {
    if (signalControl) {
      signalControl.onExit();
    } else {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    }
  }
}

export async function prepareMigratedScratchDatabaseTemplate(
  baseUrl: string,
  name = `scratch_template_${crypto.randomUUID().replaceAll("-", "")}`,
  options?: { createdFile?: string },
): Promise<string> {
  assertDatabaseName(name);
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  admin.on("error", () => {});
  let created = false;
  let receivedSignal: NodeJS.Signals | undefined;
  let activeMigrate: ReturnType<typeof Bun.spawn> | undefined;
  let createInFlight = false;
  let backendPid: number | undefined;
  let cancelPromise: Promise<void> | undefined;
  let startCancelCreateTimer: ((signal: NodeJS.Signals) => void) | undefined;

  const requestCancelInFlightCreate = (signal: NodeJS.Signals) => {
    startCancelCreateTimer?.(signal);
    if (cancelPromise || !backendPid) return;
    const pid = backendPid;
    const cancelPool = new pg.Pool({
      connectionString: baseUrl,
      max: 1,
      connectionTimeoutMillis: CANCEL_BACKEND_WAIT_MS,
    });
    cancelPool.on("error", () => {});
    cancelPromise = (async () => {
      let cancelClient: pg.PoolClient | undefined;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        cancelClient = await cancelPool.connect();
        cancelClient.on("error", () => {});
        const query = cancelClient.query(`SELECT pg_cancel_backend($1)`, [pid]);
        query.catch(() => undefined);
        await Promise.race([
          query,
          new Promise<void>((resolve) => {
            cancelTimer = setTimeout(() => {
              timedOut = true;
              if (cancelClient) destroyPgClientStream(cancelClient);
              resolve();
            }, CANCEL_BACKEND_WAIT_MS);
          }),
        ]);
      } catch {
        // Best-effort backend cancel; createQuery's bounded wait remains authoritative.
      } finally {
        if (cancelTimer) clearTimeout(cancelTimer);
        if (cancelClient) {
          cancelClient.release(timedOut ? new Error("cancel query timed out") : undefined);
        }
        await cancelPool.end().catch(() => undefined);
      }
    })();
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (!receivedSignal) {
      receivedSignal = signal;
    }
    if (activeMigrate) {
      activeMigrate.kill(signal);
    } else if (createInFlight) {
      requestCancelInFlightCreate(signal);
    }
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const createClient = await admin.connect();
    createClient.on("error", () => {});
    let destroyCreateClient = false;
    try {
      const pidRes = await createClient.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      backendPid = pidRes.rows[0]?.pid;
      if (receivedSignal) {
        throw new Error(
          `scratch template preparation interrupted by ${receivedSignal} before CREATE DATABASE`,
        );
      }

      const createQuery = createClient.query(`CREATE DATABASE "${name}"`);
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const cancelTimeout = new Promise<never>((_, reject) => {
        startCancelCreateTimer = (signal: NodeJS.Signals) => {
          if (cancelTimer) return;
          cancelTimer = setTimeout(() => {
            destroyCreateClient = true;
            destroyPgClientStream(createClient);
            reject(
              new Error(
                `Timed out waiting for CREATE DATABASE "${name}" confirmation after ${signal}; outcome is uncertain, preserving database state without dropping`,
              ),
            );
          }, CANCEL_CREATE_WAIT_MS);
        };
      });
      createQuery.catch(() => {});
      createInFlight = true;
      try {
        await Promise.race([createQuery, cancelTimeout]);
        created = true;
        recordCreatedDatabase(options?.createdFile, name);
      } catch (createError) {
        if (!hasPgErrorCode(createError)) {
          destroyCreateClient = true;
          const message = createError instanceof Error ? createError.message : String(createError);
          if (message.includes("outcome is uncertain")) throw createError;
          throw new Error(
            `Lost connection before CREATE DATABASE "${name}" confirmed; outcome is uncertain, preserving database state without dropping: ${message}`,
          );
        }
        throw createError;
      } finally {
        createInFlight = false;
        startCancelCreateTimer = undefined;
        if (cancelTimer) clearTimeout(cancelTimer);
      }
    } finally {
      createClient.release(destroyCreateClient ? new Error("discard create client") : undefined);
    }

    if (receivedSignal) {
      throw new Error(
        `scratch template preparation interrupted by ${receivedSignal} after CREATE DATABASE`,
      );
    }

    const templateUrl = new URL(baseUrl);
    templateUrl.pathname = `/${name}`;
    await migrateScratchDatabase(templateUrl.href, name, {
      onSpawn: (proc) => {
        activeMigrate = proc;
        if (receivedSignal) proc.kill(receivedSignal);
      },
      onExit: () => {
        activeMigrate = undefined;
      },
      getReceivedSignal: () => receivedSignal,
    });

    if (receivedSignal) {
      throw new Error(
        `scratch template preparation interrupted by ${receivedSignal} after migration`,
      );
    }

    await admin.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
    await waitForNoConnections(admin, name);

    if (receivedSignal) {
      throw new Error(
        `scratch template preparation interrupted by ${receivedSignal} before completion`,
      );
    }

    return name;
  } catch (error) {
    if (created) {
      try {
        await dropScratchDatabase(admin, name);
        if (options?.createdFile) writeFileSync(options.createdFile, "", "utf8");
      } catch (dropError) {
        console.error(`Failed to drop scratch template ${name}:`, dropError);
      }
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (cancelPromise) await cancelPromise;
    await admin.end();
  }
}

export async function dropMigratedScratchDatabaseTemplate(
  baseUrl: string,
  name: string,
): Promise<void> {
  assertDatabaseName(name);
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  try {
    await dropScratchDatabase(admin, name);
  } finally {
    await admin.end();
  }
}

export async function cleanupRecordedScratchDatabases(
  baseUrl: string,
  registryFile: string,
): Promise<void> {
  const names = parseActiveRegistryEntries(readFileSync(registryFile, "utf8"));
  if (names.length === 0) return;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const failures: Array<{ name: string; error: unknown }> = [];
  try {
    for (const name of names.reverse()) {
      try {
        await dropScratchDatabase(admin, name);
      } catch (error) {
        failures.push({ name, error });
      }
    }
  } finally {
    await admin.end();
  }
  if (failures.length > 0) {
    const details = failures
      .map(
        ({ name, error }) => `${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
      .join("; ");
    throw new Error(`Failed to drop scratch database(s): ${details}`);
  }
}

export async function createMigratedScratchDatabase(
  baseUrl: string,
  prefix: string,
): Promise<ScratchDatabase> {
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  const name = assertDatabaseName(`${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
  const template = configuredTemplateFor(baseUrl);
  const createdFile = template
    ? process.env[SCRATCH_DATABASE_CREATED_FILE_ENV]?.trim() || undefined
    : undefined;
  try {
    await admin.query(
      template ? `CREATE DATABASE "${name}" TEMPLATE "${template}"` : `CREATE DATABASE "${name}"`,
    );
    recordCreatedDatabase(createdFile, name);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const scratch = new URL(baseUrl);
  scratch.pathname = `/${name}`;
  if (!template) {
    try {
      await migrateScratchDatabase(scratch.href, name);
    } catch (error) {
      try {
        await dropScratchDatabase(admin, name);
      } finally {
        await admin.end();
      }
      throw error;
    }
  }
  return {
    url: scratch.href,
    drop: async () => {
      try {
        await dropScratchDatabase(admin, name);
        recordDroppedDatabase(createdFile, name);
      } finally {
        await admin.end();
      }
    },
  };
}

if (import.meta.main) {
  const [command, target] = process.argv.slice(2);
  const baseUrl = process.env.DATABASE_URL?.trim();
  if (!baseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  if (command === "prepare" && target) {
    const createdFile = process.env[SCRATCH_DATABASE_CREATED_FILE_ENV]?.trim() || undefined;
    await prepareMigratedScratchDatabaseTemplate(baseUrl, target, { createdFile });
  } else if (command === "drop" && target) {
    await dropMigratedScratchDatabaseTemplate(baseUrl, target);
  } else if (command === "cleanup" && target) {
    await cleanupRecordedScratchDatabases(baseUrl, target);
  } else {
    console.error(
      "usage: DATABASE_URL=<url> bun scratch-database.ts <prepare|drop|cleanup> <target>",
    );
    process.exit(2);
  }
}
