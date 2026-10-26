import { ProcessChannel } from "#src/platform/process-channel";

// A live native job deliberately never confirms terminal cleanup; no child is launched.
process.on("SIGTERM", () => {});
const channel = new ProcessChannel((record) => {
  if (record.type === "start") {
    channel.send({ type: "started", pid: process.pid });
    channel.send({ type: "stdout", data: Buffer.from("ready\n").toString("base64") });
  }
});
await Bun.connect({
  unix: Bun.argv.at(-1)!,
  socket: {
    open(socket) {
      channel.attach(socket);
      channel.send({ type: "hello", pid: process.pid });
    },
    data(_socket, bytes) {
      channel.read(bytes);
    },
    drain() {
      channel.drain();
    },
    close() {
      process.exit(1);
    },
    error() {
      process.exit(1);
    },
  },
});
