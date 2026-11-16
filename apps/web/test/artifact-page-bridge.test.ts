import { describe, expect, test } from "bun:test";
import {
  BRIDGE_DATA_RATE_LIMIT_PER_MINUTE,
  BRIDGE_DECLINES_BEFORE_MUTE,
  BRIDGE_ERROR_REPORTS,
  BRIDGE_RATE_LIMIT_PER_MINUTE,
  createPageBridge,
  httpUrl,
  PageHostError,
  type PageBridgeHost,
  type PageConfirm,
  type PageDataCall,
} from "#src/features/artifacts/artifact-page-bridge";

async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

const ORIGIN = "https://a-11111111-1111-4111-8111-111111111111.sandbox.example";

function setup(overrides: Partial<PageBridgeHost> = {}) {
  const log: unknown[] = [];
  const frameWindow = { posted: [] as unknown[] } as unknown as Window & { posted: unknown[] };
  (
    frameWindow as unknown as { postMessage: (message: unknown, target: string) => void }
  ).postMessage = (message, target) => {
    expect(target).toBe(ORIGIN);
    frameWindow.posted.push(message);
    log.push(message);
  };
  let clock = 0;
  const calls = {
    errors: [] as string[],
    opened: [] as string[],
    composer: [] as unknown[],
    data: [] as PageDataCall[],
    confirms: [] as PageConfirm[],
    uploads: [] as string[],
    deleted: [] as string[],
  };
  const changed = new Set<(collection: string) => void>();
  const host: PageBridgeHost = {
    level: "interact",
    data: {
      call: async (call) => {
        calls.data.push(call);
        if (call.method === "get") return { document: { id: call.id, version: 1 } };
        if (call.method === "write")
          return { results: call.writes.map((w) => ({ id: w.id, version: 1 })) };
        return { documents: [], next: null };
      },
      subscribe: (listener) => {
        changed.add(listener);
        return () => void changed.delete(listener);
      },
    },
    assets: {
      list: async () => ({ assets: [{ name: "a.png" }] }),
      upload: async (_file, name) => {
        calls.uploads.push(name);
        return { name };
      },
      delete: async (name) => {
        calls.deleted.push(name);
        return { deleted: true };
      },
    },
    viewer: { displayName: "Lin Xia", kind: "person" },
    artifact: { id: "a1", title: "Launch", version: 3, entryPath: "index.html" },
    theme: () => "dark",
    userActive: () => true,
    copyText: async () => true,
    confirm: async (request) => {
      calls.confirms.push(request);
      return true;
    },
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
    return (frameWindow.posted as { id?: number }[]).find((message) => message.id === id) as
      | { id: number; result?: unknown; error?: { code: number; message: string } }
      | undefined;
  };
  const call = (namespace: string, method: string, args?: object) =>
    ask("coforge/call", { namespace, method, args });
  return {
    bridge,
    ask,
    call,
    calls,
    frameWindow,
    log,
    changed: (collection: string) => changed.forEach((listener) => listener(collection)),
    watchers: () => changed.size,
    tick: (ms: number) => (clock += ms),
  };
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
        "coforge/runtime": {
          namespaces: ["user", "artifact", "clipboard", "links", "comments", "db", "assets"],
        },
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
    expect((await call("fs", "get"))?.error?.code).toBe(-32601);
    expect((await call("db", "drop"))?.error?.code).toBe(-32601);
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
      confirm: async () => {
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

  test("the handshake offers only what the viewer's level allows a method of", async () => {
    const { ask } = setup({ level: "view" });
    const answer = await ask("ui/initialize", {});
    expect(answer?.result).toMatchObject({
      experimental: { "coforge/runtime": { namespaces: expect.arrayContaining(["db", "assets"]) } },
    });
  });

  test("reads need only view; writes, uploads and deletes have a floor the page cannot lower", async () => {
    const { call, calls } = setup({ level: "view" });
    expect((await call("db", "get", { collection: "c", id: "a" }))?.result).toEqual({
      id: "a",
      version: 1,
    });
    expect((await call("db", "query", { collection: "c" }))?.result).toEqual({
      documents: [],
      next: null,
    });
    expect((await call("assets", "list"))?.result).toEqual([{ name: "a.png" }]);
    for (const [namespace, method, args] of [
      ["db", "set", { collection: "c", id: "a", data: {} }],
      ["db", "update", { collection: "c", id: "a", data: {} }],
      ["db", "delete", { collection: "c", id: "a" }],
      ["db", "batch", { ops: [{ op: "delete", collection: "c", id: "a" }] }],
      ["assets", "upload", { file: new Blob(["x"]), name: "a.txt" }],
      ["assets", "delete", { name: "a.png" }],
    ] as const)
      expect((await call(namespace, method, args))?.error, `${namespace}.${method}`).toEqual({
        code: -32000,
        message: "Not allowed",
      });
    expect(calls.confirms).toEqual([]);
    expect(calls.data.every((entry) => entry.method !== "write")).toBe(true);
  });

  test("an admin deletes assets; an interacting member does not", async () => {
    const member = setup({ level: "interact" });
    expect((await member.call("assets", "delete", { name: "a.png" }))?.error?.message).toBe(
      "Not allowed",
    );
    const admin = setup({ level: "admin" });
    expect((await admin.call("assets", "delete", { name: "a.png" }))?.result).toEqual({
      deleted: true,
    });
    expect(admin.calls.confirms).toEqual([{ kind: "delete", name: "a.png" }]);
  });

  test("a write is confirmed once, with the paths it changes, and the consent is kept for the frame", async () => {
    const { call, calls } = setup();
    const set = (id: string) => call("db", "set", { collection: "notes", id, data: { n: 1 } });
    expect((await set("a"))?.result).toEqual({ id: "a", version: 1 });
    expect(calls.confirms).toEqual([{ kind: "data", paths: ["notes/a"] }]);
    await set("b");
    expect(
      (
        await call("db", "batch", {
          ops: [
            { op: "set", collection: "notes", id: "c", data: {} },
            { op: "delete", collection: "notes", id: "d" },
          ],
        })
      )?.result,
    ).toEqual([
      { id: "c", version: 1 },
      { id: "d", version: 1 },
    ]);
    expect(calls.confirms).toHaveLength(1);
  });

  test("a declined write reaches no server, and three declines mute writes only", async () => {
    const { call, calls } = setup({ confirm: async () => false });
    for (let i = 0; i < BRIDGE_DECLINES_BEFORE_MUTE; i++)
      expect(
        (await call("db", "set", { collection: "c", id: "a", data: {} }))?.error?.message,
      ).toBe("Declined");
    expect((await call("db", "set", { collection: "c", id: "a", data: {} }))?.error?.message).toBe(
      "Muted",
    );
    expect(calls.data).toEqual([]);
    expect((await call("db", "get", { collection: "c", id: "a" }))?.result).toBeDefined();
  });

  test("malformed data calls are refused before anything is asked or sent", async () => {
    const { call, calls } = setup();
    for (const args of [
      {},
      { collection: "", id: "a", data: {} },
      { collection: "c", id: 5, data: {} },
      { collection: "c", id: "a", data: {}, ifVersion: 1.5 },
    ])
      expect((await call("db", "set", args))?.error?.code).toBe(-32602);
    for (const ops of [undefined, [], "x", Array.from({ length: 51 }, () => ({}))])
      expect((await call("db", "batch", { ops }))?.error?.code).toBe(-32602);
    expect(
      (await call("db", "batch", { ops: [{ op: "drop", collection: "c", id: "a" }] }))?.error?.code,
    ).toBe(-32602);
    expect(calls.confirms).toEqual([]);
    expect(calls.data).toEqual([]);
  });

  test("a failure the host names reaches the page by its reason; any other is plain", async () => {
    const named = setup({
      data: {
        call: async () => {
          throw new PageHostError("artifact-data-version");
        },
        subscribe: () => () => {},
      },
    });
    expect((await named.call("db", "get", { collection: "c", id: "a" }))?.error).toEqual({
      code: -32000,
      message: "artifact-data-version",
    });
    const plain = setup({
      data: {
        call: async () => {
          throw new Error("select * from secrets failed");
        },
        subscribe: () => () => {},
      },
    });
    expect((await plain.call("db", "get", { collection: "c", id: "a" }))?.error?.message).toBe(
      "Failed",
    );
  });

  test("db calls have a higher per-minute limit than the rest", async () => {
    const { call } = setup();
    for (let i = 0; i < BRIDGE_DATA_RATE_LIMIT_PER_MINUTE; i++)
      expect((await call("db", "get", { collection: "c", id: "a" }))?.result).toBeDefined();
    expect((await call("db", "get", { collection: "c", id: "a" }))?.error?.message).toBe(
      "Too many requests",
    );
  });

  test("a watch sends the result at once and again when its collection changes, until it stops", async () => {
    const { call, log, changed, watchers } = setup();
    const watchMessages = () =>
      (log as { method?: string; params?: { id: string } }[]).filter(
        (message) => message.method === "coforge/watch",
      );
    expect((await call("db", "watch", { id: "w1", collection: "notes" }))?.result).toEqual({
      watching: true,
    });
    await until(() => watchMessages().length === 1);
    changed("other");
    changed("notes");
    await until(() => watchMessages().length === 2);
    expect(watchMessages()[1]).toMatchObject({ params: { id: "w1", result: { documents: [] } } });
    await call("db", "unwatch", { id: "w1" });
    expect(watchers()).toBe(0);
    changed("notes");
    await Bun.sleep(20);
    expect(watchMessages()).toHaveLength(2);
  });

  test("a frame holds at most 20 watches", async () => {
    const { call } = setup();
    for (let i = 0; i < 20; i++)
      expect((await call("db", "watch", { id: `w${i}`, collection: "c" }))?.result).toBeDefined();
    expect((await call("db", "watch", { id: "w20", collection: "c" }))?.error?.code).toBe(-32602);
  });

  test("a file is confirmed before it is added, and must be a non-empty blob of at most 10 MiB", async () => {
    const { call, calls } = setup();
    expect(
      (await call("assets", "upload", { file: new Blob(["hello"]), name: "a.txt" }))?.result,
    ).toEqual({ name: "a.txt" });
    expect(calls.confirms).toEqual([{ kind: "upload", name: "a.txt", sizeBytes: 5 }]);
    expect(calls.uploads).toEqual(["a.txt"]);
    for (const args of [
      {},
      { file: "text", name: "a.txt" },
      { file: new Blob([]), name: "a.txt" },
      { file: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), name: "a.txt" },
      { file: new Blob(["x"]) },
    ])
      expect((await call("assets", "upload", args))?.error?.code).toBe(-32602);
    expect(calls.uploads).toHaveLength(1);
  });

  test("only http and https URLs pass", () => {
    expect(httpUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(httpUrl("ftp://example.com")).toBeNull();
    expect(httpUrl("x".repeat(3000))).toBeNull();
  });
});
