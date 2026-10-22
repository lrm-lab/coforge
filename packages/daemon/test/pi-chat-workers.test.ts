import { expect, test } from "bun:test";
import { PiChatWorkers } from "#src/pi-chat/workers";

test("the Workspace daemon relays independent Pi input and live feedback without any host HTTP or Docker", async () => {
  const scope = {
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
  };
  const event = Promise.withResolvers<unknown>();
  const workers = new PiChatWorkers(scope, (update) => event.resolve(update), {
    command: [
      process.execPath,
      "-e",
      `
      let text = "";
      for await (const chunk of Bun.stdin.stream()) {
        text += new TextDecoder().decode(chunk);
        let end;
        while ((end = text.indexOf("\\n")) >= 0) {
          const request = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
          console.log(JSON.stringify({ event: { sessionId: "00000000-0000-4000-8000-000000000001", stream: { id: "00000000-0000-4000-8000-000000000002", sequence: 1 }, messages: [{ id: "streaming", role: "assistant", text: "partial" }] } }));
          console.log(JSON.stringify({ id: request.id, result: { sessions: [] } }));
        }
      }`,
    ],
  });
  try {
    expect(await workers.execute(scope, { action: "list" })).toEqual({ sessions: [] });
    expect(await event.promise).toMatchObject({ messages: [{ text: "partial" }] });
    await expect(
      workers.execute({ ...scope, workspaceId: crypto.randomUUID() }, { action: "list" }),
    ).rejects.toThrow("scope");
  } finally {
    await workers.close();
  }
  await expect(workers.execute(scope, { action: "list" })).rejects.toThrow("closed");
}, 40_000);

test("closing a worker forcibly terminates a child that ignores graceful shutdown", async () => {
  const scope = {
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
  };
  const workers = new PiChatWorkers(scope, () => {}, {
    command: [
      process.execPath,
      "-e",
      `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(0), 60_000);
      for await (const chunk of Bun.stdin.stream()) {
        const request = JSON.parse(new TextDecoder().decode(chunk));
        console.log(JSON.stringify({ id: request.id, result: { sessions: [] } }));
      }
    `,
    ],
  });
  await workers.execute(scope, { action: "list" });
  const started = Date.now();
  await workers.close();
  expect(Date.now() - started).toBeLessThan(40_000);
}, 45_000);
