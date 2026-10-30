import { afterEach, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { databasePoolConfig } from "#src/server/db/pool-config.server";
import { StatementPool } from "#src/server/db/statement-pool.server";

/**
 * The database is reached through a local proxy that can freeze the connections it has open —
 * what a NAT silently dropping idle connections leaves behind (task #348) — while new ones pass.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const LIMIT_MS = 500;

type Link = { frozen: boolean; upstream?: Bun.Socket; early: Uint8Array[] };

/** A TCP proxy to `target`; `freeze()` makes every connection open so far swallow traffic. */
function freezableProxy(target: URL) {
  const links = new Set<Link>();
  let opened = 0;
  const server = Bun.listen<Link>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        opened += 1;
        const link: Link = { frozen: false, early: [] };
        client.data = link;
        links.add(link);
        void Bun.connect({
          hostname: target.hostname,
          port: Number(target.port || 5432),
          socket: {
            open(upstream) {
              link.upstream = upstream;
              for (const chunk of link.early.splice(0)) upstream.write(chunk);
            },
            data(_upstream, chunk) {
              if (!link.frozen) client.write(chunk);
            },
            close() {
              client.end();
            },
          },
        });
      },
      data(client, chunk) {
        const link = client.data;
        if (link.frozen) return;
        if (link.upstream) link.upstream.write(chunk);
        else link.early.push(new Uint8Array(chunk));
      },
      close(client) {
        client.data.upstream?.end();
        links.delete(client.data);
      },
    },
  });
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(server.port);
  return {
    url: url.toString(),
    opened: () => opened,
    freeze() {
      for (const link of links) link.frozen = true;
    },
    stop: () => server.stop(true),
  };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function throughProxy() {
  const proxy = freezableProxy(new URL(connectionString!));
  const db = new PrismaClient({
    adapter: new PrismaPg(new StatementPool(databasePoolConfig(proxy.url), LIMIT_MS), {
      disposeExternalPool: true,
    }),
  });
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  cleanup = async () => {
    warnings.mockRestore();
    await db.$disconnect().catch(() => undefined);
    proxy.stop();
  };
  const events = () =>
    warnings.mock.calls.map(([line]) => {
      const { event, reason } = JSON.parse(String(line)) as { event: string; reason: string };
      return { event, reason };
    });
  return { db, proxy, events };
}

const elapsed = async <T>(run: () => Promise<T>) => {
  const startedAt = performance.now();
  const outcome = await run().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { ...outcome, ms: performance.now() - startedAt };
};

test.skipIf(!connectionString)(
  "a read on a connection that stopped answering is run again on a new one, not another idle one",
  async () => {
    const { db, proxy, events } = await throughProxy();
    // Two idle connections in the pool, both frozen.
    const [workspaces] = await Promise.all([
      db.workspace.count(),
      db.$queryRaw`SELECT pg_sleep(0.05)::text`,
    ]);
    expect(proxy.opened()).toBe(2);
    proxy.freeze();

    const read = await elapsed(() => db.workspace.count());
    expect(read).toMatchObject({ value: workspaces });
    expect(read.ms).toBeLessThan(LIMIT_MS * 2);
    expect(proxy.opened()).toBe(3);
    expect(events()).toEqual([{ event: "database:statement_retried", reason: "timeout" }]);
  },
);

test.skipIf(!connectionString)(
  "a write on a connection that stopped answering fails within the limit and is not run again",
  async () => {
    const { db, proxy, events } = await throughProxy();
    await db.$queryRaw`SELECT 1`;
    proxy.freeze();

    const write = await elapsed(() => db.$executeRaw`SET application_name = 'statement-pool'`);
    expect(write).toHaveProperty("error");
    expect(write.ms).toBeLessThan(LIMIT_MS * 2);
    expect(proxy.opened()).toBe(1);
    expect(events()).toEqual([{ event: "database:statement_lost", reason: "timeout" }]);
  },
);

test.skipIf(!connectionString)(
  "a transaction keeps its own time; a single statement does not",
  async () => {
    const { db, events } = await throughProxy();
    const slow = (client: Pick<PrismaClient, "$queryRaw">) =>
      client.$queryRaw`SELECT pg_sleep(${(LIMIT_MS * 2) / 1000})::text AS slept`;

    expect(await db.$transaction(slow)).toHaveLength(1);
    // A read slower than the limit on a live database is run twice, and logged.
    expect(await elapsed(() => slow(db))).toHaveProperty("error");
    expect(events()).toEqual([{ event: "database:statement_retried", reason: "timeout" }]);
  },
);
