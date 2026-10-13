import { Centrifuge } from "centrifuge";
import WebSocket from "ws";

async function probe(url: string, label: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (msg: string) => { console.log(label, msg); resolve(); };
    const timer = setTimeout(() => done("TIMEOUT no reply in 12s"), 12000);
    try {
      const c = new Centrifuge(url, {
        websocket: WebSocket,
        onPrivateSubscribe: () => ({}),
        getData: async () => ({ probe: true }),
      } as any);
      c.on("connected", (ctx: any) => { clearTimeout(timer); done(`CONNECTED client=${ctx.client?.slice(0, 8)}`); c.disconnect(); });
      c.on("error", (e: any) => { /* keep waiting for disconnected */ });
      c.on("disconnected", (d: any) => { clearTimeout(timer); done(`DISCONNECTED code=${d?.code} reason=${d?.reason}`); });
      c.connect();
    } catch (e) { clearTimeout(timer); done(`THROW ${String(e)}`); }
  });
}

await probe("ws://127.0.0.1:18000/connection/websocket", "[18000]");
await probe("ws://127.0.0.1:18001/connection/websocket", "[18001]");
process.exit(0);
