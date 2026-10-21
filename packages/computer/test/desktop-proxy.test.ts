import { describe, expect, test } from "bun:test";

import { createDockerContainers, parseDesktopInspect } from "#src/host/docker-containers";
import { adaptDesktopHtml, parseDesktopRoute, startDesktopProxy } from "#src/host/desktop-proxy";

const oldPage = `<!DOCTYPE html>
<script type="module">
    import RFB from "/core/rfb.js";
    const token = new URLSearchParams(location.search).get("token") || "";
    if (!token) {
      document.body.textContent = "缺少连接令牌";
    }
</script>
`;

describe("desktop route", () => {
  test("maps a computer path onto the container desktop", () => {
    expect(parseDesktopRoute("/desktop/computer-1")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/desktop.html",
    });
    expect(parseDesktopRoute("/desktop/computer-1/core/rfb.js")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/core/rfb.js",
    });
    expect(parseDesktopRoute("/other")).toBeUndefined();
    expect(parseDesktopRoute("/desktop/../etc/passwd")).toBeUndefined();
    expect(parseDesktopRoute("/desktop/computer-1//websockify")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/websockify",
    });
  });

  test("reads the container address and desktop token from inspect output", () => {
    expect(
      parseDesktopInspect("COFORGE_COMPUTER_ID=abc\nVNC_WS_TOKEN=desk-token\n---\n\n172.17.0.20\n"),
    ).toEqual({ ip: "172.17.0.20", token: "desk-token" });
  });

  test("an older desktop page no longer demands a token in the address", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('from "./core/rfb.js"');
    expect(html).not.toContain("缺少连接令牌");
    expect(html).toContain("/websockify");
  });
});

describe("desktop proxy", () => {
  test("forwards a page and its assets to the computer", async () => {
    const seen: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname} token=${request.headers.get("x-vnc-token")}`);
        if (url.pathname === "/desktop.html") return new Response(oldPage, { status: 200 });
        if (url.pathname === "/core/rfb.js") return new Response("rfb", { status: 200 });
        return new Response("missing", { status: 404 });
      },
    });
    const upstreamPort = upstream.port;
    if (upstreamPort === undefined) throw new Error("upstream did not bind");
    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      resolve: async (computerId) =>
        computerId === "computer-1"
          ? { host: "127.0.0.1", port: upstreamPort, token: "desk-token" }
          : undefined,
    });
    try {
      const page = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('from "./core/rfb.js"');
      expect(html).not.toContain("缺少连接令牌");
      const asset = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/rfb.js`);
      expect(await asset.text()).toBe("rfb");
      const missing = await fetch(`http://127.0.0.1:${proxy.port}/desktop/other/`);
      expect(missing.status).toBe(404);
      expect(seen).toEqual([
        "GET /desktop.html token=desk-token",
        "GET /core/rfb.js token=desk-token",
      ]);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("a websocket reaches the computer with the token kept off the browser url", async () => {
    let upstreamToken = "";
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        upstreamToken = new URL(request.url).searchParams.get("token") ?? "";
        if (server.upgrade(request)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          ws.send(message);
        },
      },
    });
    const upstreamPort = upstream.port;
    if (upstreamPort === undefined) throw new Error("upstream did not bind");
    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      resolve: async () => ({ host: "127.0.0.1", port: upstreamPort, token: "desk-token" }),
    });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/desktop/computer-1/websockify`);
      const echoed = await new Promise<string>((resolve, reject) => {
        socket.addEventListener("open", () => socket.send("ping"));
        socket.addEventListener("message", (event) => resolve(String(event.data)));
        socket.addEventListener("error", () => reject(new Error("websocket failed")));
      });
      expect(echoed).toBe("ping");
      expect(upstreamToken).toBe("desk-token");
      expect(socket.url).not.toContain("desk-token");
      socket.close();
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });
});

describe("desktop endpoint lookup", () => {
  test("uses the task address and falls back to the token file", async () => {
    const containers = createDockerContainers(async (args) => {
      if (args[0] === "ps") return { exitCode: 0, stdout: "task-1\n", stderr: "" };
      if (args[0] === "inspect") {
        return { exitCode: 0, stdout: "COFORGE_COMPUTER_ID=abc\n---\n172.17.0.9\n", stderr: "" };
      }
      if (args[0] === "exec") return { exitCode: 0, stdout: "file-token\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    });
    await expect(containers.desktopEndpoint("computer-1")).resolves.toEqual({
      host: "172.17.0.9",
      port: 6080,
      token: "file-token",
    });
  });
});
