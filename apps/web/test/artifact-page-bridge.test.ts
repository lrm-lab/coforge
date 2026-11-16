import { describe, expect, test } from "bun:test";
import {
  BRIDGE_DECLINES_BEFORE_MUTE,
  BRIDGE_ERROR_REPORTS,
  BRIDGE_RATE_LIMIT_PER_MINUTE,
  createPageBridge,
  httpUrl,
  type PageBridgeHost,
} from "#src/features/artifacts/artifact-page-bridge";

const ORIGIN = "https://a-11111111-1111-4111-8111-111111111111.sandbox.example";

function setup(overrides: Partial<PageBridgeHost> = {}) {
  const frameWindow = { posted: [] as unknown[] } as unknown as Window & { posted: unknown[] };
  (
    frameWindow as unknown as { postMessage: (message: unknown, target: string) => void }
  ).postMessage = (message, target) => {
    expect(target).toBe(ORIGIN);
    frameWindow.posted.push(message);
  };
  let clock = 0;
  const calls = { errors: [] as string[], opened: [] as string[], composer: [] as unknown[] };
  const host: PageBridgeHost = {
    viewer: { displayName: "Lin Xia", kind: "person" },
    artifact: { id: "a1", title: "Launch", version: 3, entryPath: "index.html" },
    theme: () => "dark",
    userActive: () => true,
    copyText: async () => true,
    confirmOpenLink: async () => true,
    openLink: (url) => calls.opened.push(url),
    openComposer: (options) => {
      calls.composer.push(options);
      return true;
    },
    reportError: (message) => calls.errors.push(message),
    reportFind: () => {},
    frameStatus: () => {},
    now: () => clock,
    ...overrides,
  };
  const bridge = createPageBridge(host, { origin: ORIGIN, window: () => frameWindow });
  const ask = async (
    method: string,
    params?: object,
    id = 1,
    source: unknown = frameWindow,
    origin = ORIGIN,
  ) => {
    frameWindow.posted.length = 0;
    await bridge.handle({
      source: source as MessageEventSource,
      origin,
      data: { jsonrpc: "2.0", id, method, params },
    });
    return frameWindow.posted[0] as
      | { id: number; result?: unknown; error?: { code: number; message: string } }
      | undefined;
  };
  const call = (namespace: string, method: string, args?: object) =>
    ask("coforge/call", { namespace, method, args });
  return { bridge, ask, call, calls, frameWindow, tick: (ms: number) => (clock += ms) };
}

describe("the page bridge", () => {
  test("answers only its own frame at its exact origin", async () => {
    const { ask } = setup();
    expect(await ask("ui/initialize", {}, 1, {}, ORIGIN)).toBeUndefined();
    expect(await ask("ui/initialize", {}, 1, undefined, "https://evil.example")).toBeUndefined();
    expect(await ask("ui/initialize", {}, 1, undefined, "null")).toBeUndefined();
  });

  test("the handshake offers the namespaces and the theme", async () => {
    const { ask } = setup();
    const answer = await ask("ui/initialize", {});
    expect(answer?.result).toMatchObject({
      hostContext: { theme: "dark" },
      experimental: {
        "coforge/runtime": { namespaces: ["user", "artifact", "clipboard", "links", "comments"] },
      },
    });
  });

  test("user.get and artifact.get answer", async () => {
    const { call } = setup();
    expect((await call("user", "get"))?.result).toEqual({ displayName: "Lin Xia", kind: "person" });
    expect((await call("artifact", "get"))?.result).toEqual({
      id: "a1",
      title: "Launch",
      version: 3,
      entryPath: "index.html",
    });
  });

  test("an unknown method or call is method not found", async () => {
    const { ask, call } = setup();
    expect((await ask("ui/message", { content: [] }))?.error?.code).toBe(-32601);
    expect((await ask("tools/call", {}))?.error?.code).toBe(-32601);
    expect((await call("db", "get"))?.error?.code).toBe(-32601);
    expect((await call("user", "toString"))?.error?.code).toBe(-32601);
    expect((await call("constructor", "x"))?.error?.code).toBe(-32601);
  });

  test("copying needs a user activation, which the host checks", async () => {
    let active = false;
    const copied: string[] = [];
    const { call } = setup({
      userActive: () => active,
      copyText: async (text) => {
        copied.push(text);
        return true;
      },
    });
    expect((await call("clipboard", "copy", { text: "hi" }))?.error?.code).toBe(-32000);
    expect(copied).toEqual([]);
    active = true;
    expect((await call("clipboard", "copy", { text: "hi" }))?.result).toEqual({ copied: true });
    expect(copied).toEqual(["hi"]);
    expect((await call("clipboard", "copy", { text: 1 }))?.error?.code).toBe(-32602);
  });

  test("a link opens only after a confirm, and only http and https", async () => {
    const { ask, calls } = setup();
    expect((await ask("ui/open-link", { url: "https://example.com/x" }))?.result).toEqual({});
    expect(calls.opened).toEqual(["https://example.com/x"]);
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "nope", 5])
      expect((await ask("ui/open-link", { url }))?.error?.code, String(url)).toBe(-32602);
    expect(calls.opened).toHaveLength(1);
  });

  test("three declined confirms mute links for the frame", async () => {
    let asked = 0;
    const { ask, calls } = setup({
      confirmOpenLink: async () => {
        asked += 1;
        return false;
      },
    });
    for (let i = 0; i < BRIDGE_DECLINES_BEFORE_MUTE; i++)
      expect((await ask("ui/open-link", { url: "https://example.com" }))?.error?.message).toBe(
        "Declined",
      );
    expect((await ask("ui/open-link", { url: "https://example.com" }))?.error?.message).toBe(
      "Muted",
    );
    expect(asked).toBe(BRIDGE_DECLINES_BEFORE_MUTE);
    expect(calls.opened).toEqual([]);
  });

  test("each method is limited per minute, per frame", async () => {
    const { call, tick } = setup();
    for (let i = 0; i < BRIDGE_RATE_LIMIT_PER_MINUTE; i++)
      expect((await call("user", "get"))?.result).toBeDefined();
    expect((await call("user", "get"))?.error?.message).toBe("Too many requests");
    expect((await call("artifact", "get"))?.result).toBeDefined();
    tick(60_000);
    expect((await call("user", "get"))?.result).toBeDefined();
  });

  test("the comment composer is asked to open with its body", async () => {
    const { call, calls } = setup();
    expect((await call("comments", "open", { body: "Approve" }))?.result).toEqual({ opened: true });
    expect(calls.composer).toEqual([{ body: "Approve" }]);
  });

  test("page errors are reported five times at most", async () => {
    const { bridge, calls, frameWindow } = setup();
    for (let i = 0; i < 9; i++)
      await bridge.handle({
        source: frameWindow,
        origin: ORIGIN,
        data: {
          jsonrpc: "2.0",
          method: "coforge/notifications/error",
          params: { message: `e${i}` },
        },
      });
    expect(calls.errors).toHaveLength(BRIDGE_ERROR_REPORTS);
  });

  test("only http and https URLs pass", () => {
    expect(httpUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(httpUrl("ftp://example.com")).toBeNull();
    expect(httpUrl("x".repeat(3000))).toBeNull();
  });
});
