import { RedisClient } from "bun";
import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const redisServer = Bun.which("redis-server");

const startupTimeoutMs = 15_000;
const shutdownGraceMs = 2_000;
const shutdownKillMs = 2_000;
const probeTimeoutMs = 250;
const cleanupMarginMs = 2_000;
const socketName = "redis.sock";

type RedisFixture = {
  client(): RedisClient;
  stop(): Promise<void>;
};

type RedisFixtureOptions = {
  command?: string[];
  parentDirectory?: string;
  startupTimeoutMs?: number;
};

export function useRedisFixture(onReady?: (client: () => RedisClient) => void): () => RedisClient {
  let fixture: RedisFixture | undefined;
  const client = () => {
    if (!fixture) throw new Error("Redis test fixture is not running");
    return fixture.client();
  };

  beforeAll(
    async () => {
      fixture = await startRedisFixture();
      onReady?.(client);
    },
    startupTimeoutMs + 2 * probeTimeoutMs + shutdownGraceMs + shutdownKillMs + cleanupMarginMs,
  );
  afterAll(
    async () => {
      await fixture?.stop();
    },
    shutdownGraceMs + shutdownKillMs + cleanupMarginMs,
  );
  return client;
}

export async function startRedisFixture(options: RedisFixtureOptions = {}): Promise<RedisFixture> {
  const command = options.command ?? redisCommand();
  const directory = await mkdtemp(join(options.parentDirectory ?? tmpdir(), "rf-"));
  const url = `redis+unix://${join(directory, socketName)}`;
  const clients = new Set<RedisClient>();
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let stopping: Promise<void> | undefined;

  const stop = () =>
    (stopping ??= (async () => {
      try {
        for (const client of clients) client.close();
        if (server) await stopRedisProcess(server);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })());

  try {
    server = Bun.spawn(command, { cwd: directory, stdout: "ignore", stderr: "ignore" });
    await waitForRedis(server, url, options.startupTimeoutMs ?? startupTimeoutMs);
    return {
      client() {
        if (stopping) throw new Error("Redis test fixture has stopped");
        const client = new RedisClient(url);
        clients.add(client);
        return client;
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Redis test fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

function redisCommand(): string[] {
  if (!redisServer) throw new Error("redis-server is required for this test suite");
  return [
    redisServer,
    "--port",
    "0",
    "--unixsocket",
    socketName,
    "--save",
    "",
    "--appendonly",
    "no",
  ];
}

async function waitForRedis(
  server: ReturnType<typeof Bun.spawn>,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) break;
    const probe = new RedisClient(url, {
      autoReconnect: false,
      connectionTimeout: probeTimeoutMs,
      idleTimeout: probeTimeoutMs,
    });
    try {
      const pong = await probe
        .connect()
        .then(() => probe.send("PING", []))
        .catch(() => undefined);
      if (pong === "PONG") return;
    } finally {
      probe.close();
    }
    await Bun.sleep(25);
  }

  if (server.exitCode !== null) {
    throw new Error(`redis-server exited with code ${server.exitCode} before readiness`);
  }
  if (server.signalCode !== null) {
    throw new Error(`redis-server exited on ${server.signalCode} before readiness`);
  }
  throw new Error(`redis-server did not become ready within ${timeoutMs}ms`);
}

async function stopRedisProcess(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  if (await exitedWithin(server, shutdownGraceMs)) return;
  server.kill("SIGKILL");
  if (await exitedWithin(server, shutdownKillMs)) return;
  throw new Error(`redis-server (pid ${server.pid}) did not exit after SIGKILL`);
}

async function exitedWithin(
  server: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      server.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
