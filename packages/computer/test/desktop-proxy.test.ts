import { describe, expect, test } from "bun:test";

import { createDockerContainers, parseDesktopInspect } from "#src/host/docker-containers";
import {
  adaptDesktopHtml,
  DESKTOP_PROXY_SECRET_HEADER,
  DESKTOP_WEBSOCKET_IDLE_TIMEOUT_SECONDS,
  desktopProxySecretAllows,
  parseDesktopRoute,
  startDesktopProxy,
  withDesktopTitle,
} from "#src/host/desktop-proxy";

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
    expect(parseDesktopRoute("/desktop/computer-1/agent-1/")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/screen/agent-1/desktop.html",
    });
    expect(parseDesktopRoute("/desktop/computer-1/fill")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/fill",
    });
    expect(parseDesktopRoute("/desktop/computer-1/inspect")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/inspect",
    });
    expect(parseDesktopRoute("/desktop/computer-1/clipboard")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/clipboard",
    });
    expect(parseDesktopRoute("/desktop/computer-1/agent-1/fill")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/screen/agent-1/fill",
    });
    expect(parseDesktopRoute("/desktop/computer-1/agent-1/inspect")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/screen/agent-1/inspect",
    });
    expect(parseDesktopRoute("/desktop/computer-1/agent-1/clipboard")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/screen/agent-1/clipboard",
    });
    expect(parseDesktopRoute("/desktop/computer-1/agent-1/websockify")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/screen/agent-1/websockify",
    });
    expect(parseDesktopRoute("/desktop/computer-1/agent-1/core/rfb.js")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/screen/agent-1/core/rfb.js",
    });
    expect(parseDesktopRoute("/desktop/computer-1/core/rfb.js")).toEqual({
      computerId: "computer-1",
      upstreamPath: "/core/rfb.js",
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

  test("a dropped desktop session offers a centered control that connects again", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('id="coforge-desktop-reconnect"');
    expect(html).toContain("重新连接");
    expect(html).not.toContain("msg.remove()");
    expect(html).toContain('addEventListener("click"');
    expect(html).toContain("new RFB");
  });

  test("a connected desktop hides the connecting overlay even when the page sets display:flex", () => {
    const page = `<!DOCTYPE html>
<style>#msg { display: flex; }</style>
<p id="msg">正在连接桌面…</p>
<script type="module">
    import RFB from "./core/rfb.js";
</script>
`;
    const html = adaptDesktopHtml(page);
    expect(html).toContain("#msg[hidden]{display:none!important}");
    expect(html).toContain("msg.hidden = true");
    expect(html).toContain("正在连接桌面…");
  });

  test("a page that already loads RFB relatively still gets the reconnect control", () => {
    const currentPage = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    const rfb = new RFB(document.getElementById("screen"), "ws://example/websockify");
    rfb.addEventListener("connect", () => msg.remove());
</script>
`;
    const html = adaptDesktopHtml(currentPage);
    expect(html).toContain('id="coforge-desktop-reconnect"');
    expect(html).toContain('id="coforge-desktop-phone-bar"');
    expect(html).not.toContain("msg.remove()");
  });

  test("a reconnect page that already has phone view is left alone", () => {
    const current = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    function coforgeDesktopPaste(text) {}
    const phone = params.get("view") === "phone";
</script>
<div id="coforge-desktop-phone-bar"></div>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    expect(adaptDesktopHtml(current)).toBe(current);
  });

  test("a focused paste sends the local plain text into the remote clipboard", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('addEventListener("paste"');
    expect(html).toContain('getData("text/plain")');
    expect(html).toContain("coforgeDesktopPaste");
    expect(html).toContain("clipboardPasteFrom(text)");
    expect(html).toContain("/clipboard");
    expect(html).toContain("sendKey(0xffe3");
    expect(html).toContain("stopImmediatePropagation");
    expect(html).toContain("preventDefault()");
  });

  test("a phone viewer can fit the shared desktop or pan at native size", () => {
    const html = adaptDesktopHtml(oldPage);
    expect(html).toContain('params.get("view") === "phone"');
    expect(html).toContain("scaleViewport = true");
    expect(html).toContain("clipViewport = true");
    expect(html).toContain("dragViewport = true");
    expect(html).toContain('id="coforge-desktop-phone-bar"');
    expect(html).toContain("适应屏幕");
    expect(html).toContain("实际大小");
  });

  test("a reconnect page that still uses extended clipboard paste is rewritten", () => {
    const stale = `<!DOCTYPE html>
<script type="module">
    import RFB from "./core/rfb.js";
    const rfb = new RFB(document.getElementById("screen"), "ws://example/websockify");
    document.addEventListener("paste", (ev) => {
      rfb.clipboardPasteFrom(ev.clipboardData.getData("text/plain"));
    });
</script>
<button type="button" id="coforge-desktop-reconnect"></button>
`;
    const html = adaptDesktopHtml(stale);
    expect(html).toContain("coforgeDesktopPaste");
    expect(html).toContain("sendKey(0xffe3");
  });

  test("the page title becomes the requested name, and markup in it stays text", () => {
    const page = "<title>云电脑桌面</title><script>ok</script>";
    expect(withDesktopTitle(page, "小明")).toBe("<title>小明</title><script>ok</script>");
    expect(withDesktopTitle(page, "A&B<C>")).toBe(
      "<title>A&amp;B&lt;C&gt;</title><script>ok</script>",
    );
    expect(withDesktopTitle(page, undefined)).toBe(page);
    expect(withDesktopTitle(page, " \n ")).toBe(page);
    expect(withDesktopTitle(page, `${"名".repeat(81)}`)).toBe(
      `<title>${"名".repeat(80)}</title><script>ok</script>`,
    );
  });
});

describe("desktop proxy secret", () => {
  test("allows every caller when no secret is configured", () => {
    expect(desktopProxySecretAllows(new Request("http://x/desktop/a/"), undefined)).toBe(true);
    expect(desktopProxySecretAllows(new Request("http://x/desktop/a/"), "")).toBe(true);
  });

  test("requires an exact header match when a secret is set", () => {
    const withSecret = new Request("http://x/desktop/a/", {
      headers: { [DESKTOP_PROXY_SECRET_HEADER]: "gate-token" },
    });
    const wrong = new Request("http://x/desktop/a/", {
      headers: { [DESKTOP_PROXY_SECRET_HEADER]: "other" },
    });
    expect(desktopProxySecretAllows(withSecret, "gate-token")).toBe(true);
    expect(desktopProxySecretAllows(wrong, "gate-token")).toBe(false);
    expect(desktopProxySecretAllows(new Request("http://x/desktop/a/"), "gate-token")).toBe(false);
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
      expect(html).not.toContain("window.opener=null");
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

  test("a fill POST keeps its body and a content-length the container can read", async () => {
    const seen: { length: string | null; body: string }[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen.push({
          length: request.headers.get("content-length"),
          body: await request.text(),
        });
        return new Response(JSON.stringify({ filled: ["username"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
      const payload = JSON.stringify({
        fields: [{ id: "username", selector: "#user", value: "ada" }],
      });
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/desktop/computer-1/agent-1/fill`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ filled: ["username"] });
      expect(seen).toEqual([{ length: String(payload.length), body: payload }]);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("a requested title is written into the page and not sent to the container", async () => {
    const seen: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        seen.push(`${url.pathname}${url.search}`);
        return new Response("<title>云电脑桌面</title>", { status: 200 });
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
      const page = await fetch(
        `http://127.0.0.1:${proxy.port}/desktop/computer-1/agent-1/?title=${encodeURIComponent("A&B")}`,
      );
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<title>A&amp;B</title>");
      expect(seen).toEqual(["/screen/agent-1/desktop.html"]);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("rejects desktop, fill and inspect without the proxy secret", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok", { status: 200 });
      },
    });
    const upstreamPort = upstream.port;
    if (upstreamPort === undefined) throw new Error("upstream did not bind");
    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      proxySecret: "gate-token",
      resolve: async () => ({ host: "127.0.0.1", port: upstreamPort, token: "desk-token" }),
    });
    try {
      for (const path of [
        "/desktop/computer-1/",
        "/desktop/computer-1/agent-1/fill",
        "/desktop/computer-1/agent-1/inspect",
      ]) {
        const denied = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
          method: path.endsWith("fill") ? "POST" : "GET",
          body: path.endsWith("fill") ? "{}" : undefined,
        });
        expect(denied.status).toBe(403);
      }
      const allowed = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/`, {
        headers: { [DESKTOP_PROXY_SECRET_HEADER]: "gate-token" },
      });
      expect(allowed.status).toBe(200);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("keeps desktop websockets alive longer than Bun's default idle cut-off", () => {
    expect(DESKTOP_WEBSOCKET_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(120);
    expect(DESKTOP_WEBSOCKET_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(960);
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
