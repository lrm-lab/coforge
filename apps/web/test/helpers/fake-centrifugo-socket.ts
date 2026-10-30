type Command = {
  id: number;
  connect?: unknown;
  subscribe?: { channel: string; token?: string };
};

/**
 * A Centrifugo stand-in for one client of the JSON build (pass `websocket` to `new Centrifuge`):
 * the socket opens on the next task, as a real one does after `connect()` returns, and every
 * connect or subscribe command gets a success reply. `subscribeCommands` records each subscribe;
 * `publish` pushes a publication to a channel.
 */
export function fakeCentrifugoSocket() {
  const subscribeCommands: NonNullable<Command["subscribe"]>[] = [];
  let socket: FakeCentrifugoSocket | undefined;

  class FakeCentrifugoSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: (event: unknown) => void;

    constructor() {
      socket = this;
      setTimeout(() => this.onopen?.());
    }

    send(frame: string) {
      const replies = frame
        .split("\n")
        .map((line) => JSON.parse(line) as Command)
        .flatMap((command): object[] => {
          if (command.connect) return [{ id: command.id, connect: { client: "client-1" } }];
          if (command.subscribe) {
            subscribeCommands.push(command.subscribe);
            return [{ id: command.id, subscribe: {} }];
          }
          return [];
        });
      if (replies.length) this.receive(replies);
    }

    receive(replies: object[]) {
      const data = replies.map((reply) => JSON.stringify(reply)).join("\n");
      queueMicrotask(() => this.onmessage?.({ data }));
    }

    close() {
      this.onclose?.({ code: 1000, reason: "" });
    }
  }

  return {
    websocket: FakeCentrifugoSocket,
    subscribeCommands,
    publish: (channel: string, data: object) =>
      socket!.receive([{ push: { channel, pub: { data } } }]),
  };
}
