import { describe, expect, test } from "bun:test";
import { CdpClient, CdpConnectionError, pageCtx } from "../scripts/cdp-browser.mjs";
import { attemptDialog, runDialog } from "../scripts/dialog-sweep.mjs";
import { runSurfaceLoop } from "../scripts/ui-sweep.mjs";

class FakeWebSocket extends EventTarget {
  sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> =
    [];
  onSend?: (payload: {
    id: number;
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }) => void;

  send(raw: string) {
    const payload = JSON.parse(raw);
    this.sent.push(payload);
    this.onSend?.(payload);
  }

  emitMessage(msg: unknown) {
    const event = new Event("message") as Event & { data: string };
    event.data = JSON.stringify(msg);
    this.dispatchEvent(event);
  }

  emitClose() {
    this.dispatchEvent(new Event("close"));
  }
}

describe("CdpClient and pageCtx failure handling", () => {
  test("removes pending entry when ws.send throws synchronously", async () => {
    const ws = new FakeWebSocket();
    ws.onSend = () => {
      throw new Error("WebSocket is closed");
    };
    const cdp = new CdpClient(ws);
    await expect(
      cdp.send("Page.navigate", { url: "http://127.0.0.1" }, "s1"),
    ).rejects.toBeInstanceOf(CdpConnectionError);
    expect(cdp.pending.size).toBe(0);
  });

  test("navigate fails immediately on target crash after Page.navigate returns and cleans up listeners", async () => {
    const ws = new FakeWebSocket();
    const cdp = new CdpClient(ws);
    ws.onSend = (payload) => {
      if (payload.method === "Page.navigate") {
        queueMicrotask(() => {
          ws.emitMessage({ id: payload.id, result: { frameId: "f1" } });
          ws.emitMessage({ method: "Inspector.targetCrashed", sessionId: "s1" });
        });
      }
    };
    const page = pageCtx(cdp, "s1");
    const started = Date.now();
    await expect(page.navigate("http://127.0.0.1")).rejects.toBeInstanceOf(CdpConnectionError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cdp.listeners.get("Page.loadEventFired")?.size ?? 0).toBe(0);
    expect(cdp.fatalListeners.size).toBe(0);
  });

  test("navigate cleans up listeners and timer when Page.navigate rejects", async () => {
    const ws = new FakeWebSocket();
    const cdp = new CdpClient(ws);
    ws.onSend = (payload) => {
      if (payload.method === "Page.navigate") {
        queueMicrotask(() => {
          ws.emitMessage({ id: payload.id, error: { message: "net::ERR_CONNECTION_REFUSED" } });
        });
      }
    };
    const page = pageCtx(cdp, "s1");
    await expect(page.navigate("http://127.0.0.1")).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
    expect(cdp.listeners.get("Page.loadEventFired")?.size ?? 0).toBe(0);
    expect(cdp.fatalListeners.size).toBe(0);
  });

  test("screenshot rejects immediately with CdpConnectionError when socket closes mid-call", async () => {
    const ws = new FakeWebSocket();
    const cdp = new CdpClient(ws);
    ws.onSend = (payload) => {
      if (payload.method === "Page.captureScreenshot") {
        queueMicrotask(() => ws.emitClose());
      }
    };
    const page = pageCtx(cdp, "s1");
    await expect(page.screenshot("/tmp/unused-cdp-test.png")).rejects.toBeInstanceOf(
      CdpConnectionError,
    );
    expect(cdp.pending.size).toBe(0);
  });

  test("runSurfaceLoop aborts immediately on CdpConnectionError without logging captured or continuing", async () => {
    const visited: string[] = [];
    const captured: string[] = [];
    const page = {
      async navigate(url: string) {
        visited.push(url);
        throw new CdpConnectionError("Target detached");
      },
      async screenshot() {},
      consoleSnapshot: () => ({ errors: [], warnings: [] }),
      exceptionsSnapshot: () => [],
    };
    await expect(
      runSurfaceLoop({
        page,
        surfaces: [
          { key: "first", url: "http://127.0.0.1/first" },
          { key: "second", url: "http://127.0.0.1/second" },
        ],
        theme: "light",
        viewport: { name: "1440", width: 1440, height: 900 },
        outDir: "/tmp",
        evalChecks: async () => ({ findings: [], hasH1: true, sidebarWidth: 240 }),
        onCaptured: (_done: number, _count: number, record: { surface: string }) =>
          captured.push(record.surface),
      }),
    ).rejects.toBeInstanceOf(CdpConnectionError);
    expect(visited).toEqual(["http://127.0.0.1/first"]);
    expect(captured).toEqual([]);
  });

  test("runSurfaceLoop records single-page errors and continues to remaining surfaces", async () => {
    const visited: string[] = [];
    const captured: string[] = [];
    const page = {
      async navigate(url: string) {
        visited.push(url);
        if (url.endsWith("/first")) throw new Error("page eval timeout");
      },
      async screenshot() {},
      consoleSnapshot: () => ({ errors: [], warnings: [] }),
      exceptionsSnapshot: () => [],
    };
    const pass = await runSurfaceLoop({
      page,
      surfaces: [
        { key: "first", url: "http://127.0.0.1/first" },
        { key: "second", url: "http://127.0.0.1/second" },
      ],
      theme: "light",
      viewport: { name: "1440", width: 1440, height: 900 },
      outDir: "/tmp",
      evalChecks: async () => ({ findings: [], hasH1: true, sidebarWidth: 240 }),
      onCaptured: (_done: number, _count: number, record: { surface: string }) =>
        captured.push(record.surface),
    });
    const results = pass.results as Array<{ note: string | null }>;
    expect(visited).toEqual(["http://127.0.0.1/first", "http://127.0.0.1/second"]);
    expect(captured).toEqual(["first", "second"]);
    expect(results[0].note).toBe("error: page eval timeout");
    expect(results[1].note).toBeNull();
  });

  test("attemptDialog and runDialog propagate CdpConnectionError without retrying or swallowing close errors", async () => {
    let attempts = 0;
    const page = {
      async navigate() {},
      async evalJs() {
        throw new CdpConnectionError("CDP WebSocket closed");
      },
      async pressEscape() {},
    };
    const dialog = { id: "sample", steps: [], expect: "Sample" };
    await expect(
      runDialog(page, dialog, "/en/w/dev", async (...args: [unknown, unknown, string]) => {
        attempts++;
        return attemptDialog(
          args[0],
          args[1],
          args[2],
          async () => {},
          async () => {
            throw new CdpConnectionError("CDP WebSocket closed");
          },
        );
      }),
    ).rejects.toBeInstanceOf(CdpConnectionError);
    expect(attempts).toBe(1);
  });

  test("attemptDialog propagates CdpConnectionError from closeDialogs even after dialog work finishes", async () => {
    const page = {
      async navigate() {},
      async evalJs() {
        throw new CdpConnectionError("Target detached");
      },
      async pressEscape() {},
    };
    const dialog = { id: "sample", steps: [], expect: "Sample" };
    await expect(
      attemptDialog(
        page,
        dialog,
        "/en/w/dev",
        async () => {},
        async () => {},
      ),
    ).rejects.toBeInstanceOf(CdpConnectionError);
  });

  test("runDialog still retries once and returns failed status for non-connection errors", async () => {
    let evalCalls = 0;
    const page = {
      async navigate() {},
      async evalJs() {
        evalCalls++;
        return 0;
      },
      async pressEscape() {},
    };
    const dialog = { id: "sample", steps: [], expect: "Sample" };
    const status = await runDialog(page, dialog, "/en/w/dev", (p, d, w) =>
      attemptDialog(
        p,
        d,
        w,
        async () => {},
        async () => {
          throw new Error("no dialog opened");
        },
      ),
    );
    expect(status).toBe("failed: no dialog opened");
    expect(evalCalls).toBe(2);
  });
});
