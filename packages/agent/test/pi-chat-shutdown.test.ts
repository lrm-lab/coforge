import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("worker EOF bounds shutdown even if extension initialization never settles", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-chat-shutdown-"));
  const agent = join(root, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await Bun.write(
    join(agent, "extensions", "hang.ts"),
    "export default async function () { await new Promise(() => { setInterval(() => {}, 1000); }); }",
  );
  const script = `import { runPiChatWorker } from ${JSON.stringify(join(import.meta.dir, "../src/pi-chat/worker.ts"))}; await runPiChatWorker(Bun.env.PI_CHAT_TEST_ROOT, Bun.env.PI_CHAT_TEST_WORKSPACE, Bun.env.PI_CHAT_TEST_USER, { shutdownTimeoutMs: 50 });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...Bun.env,
      HOME: root,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_CHAT_TEST_ROOT: join(root, "sessions"),
      PI_CHAT_TEST_WORKSPACE: crypto.randomUUID(),
      PI_CHAT_TEST_USER: crypto.randomUUID(),
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    child.stdin.write(
      `${JSON.stringify({ id: crypto.randomUUID(), command: { action: "start", requestId: crypto.randomUUID(), message: "hello" } })}\n`,
    );
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      expect(await child.exited).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
