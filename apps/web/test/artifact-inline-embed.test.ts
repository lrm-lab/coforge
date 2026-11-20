import { describe, expect, test } from "bun:test";
import {
  createPageBridge,
  type PageBridgeHost,
} from "#src/features/artifacts/artifact-page-bridge";
import { pageRuntimeSource } from "#src/server/artifacts/artifact-page-runtime.server";

const ORIGIN = "https://a-11111111-1111-7111-8111-111111111111.coforgeusercontent.test";

type Posted = { message: unknown; origin: string };

function fakeWindow() {
  const posted: Posted[] = [];
  return {
    posted,
    postMessage(message: unknown, origin: string) {
      posted.push({ message, origin });
    },
  };
}

function createInlineBridge(
  overrides: Pick<PageBridgeHost, "themeTokens" | "onInitialized" | "onSizeChanged"> = {},
) {
  const frameWindow = fakeWindow();
  const host: PageBridgeHost = {
    viewer: { displayName: "Ada", kind: "person" },
    artifact: { id: "a1", title: "Funnel", version: 2, entryPath: "index.html" },
    level: "interact",
    displayMode: "inline",
    data: {
      call: async () => ({ documents: [], next: null }),
      subscribe: () => () => {},
    },
    assets: {
      list: async () => ({ assets: [] }),
      upload: async (_file, name) => ({ name }),
      delete: async () => ({ deleted: true }),
    },
    theme: () => "dark",
    userActive: () => true,
    copyText: async () => true,
    downloadFile: () => {},
    confirm: async () => true,
    openLink: () => {},
    suggestComment: () => true,
    reportError: () => {},
    reportFind: () => {},
    frameStatus: () => {},
    now: () => 1_000,
    ...overrides,
  };
  const bridge = createPageBridge(host, {
    origin: ORIGIN,
    window: () => frameWindow as unknown as Window,
  });
  const ask = async (method: string, params?: unknown) => {
    frameWindow.posted.length = 0;
    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    return frameWindow.posted[0]?.message as {
      result?: unknown;
      error?: { code: number; message: string };
    };
  };
  return { frameWindow, bridge, ask };
}

describe("inline embed bridge and runtime", () => {
  test("inline mode advertises displayMode and theme tokens, omits comments, and handles initialized and size-changed", async () => {
    let initializedCount = 0;
    const sizes: { width: number; height: number }[] = [];
    const tokens = { "--coforge-fg": "#101319", "--coforge-brand": "#5d36dc" };
    const { frameWindow, bridge, ask } = createInlineBridge({
      themeTokens: () => tokens,
      onInitialized: () => {
        initializedCount += 1;
      },
      onSizeChanged: (size) => sizes.push(size),
    });

    const answer = await ask("ui/initialize", {});
    expect(answer?.result).toMatchObject({
      hostContext: { theme: "dark", displayMode: "inline", tokens },
      experimental: {
        "coforge/runtime": {
          namespaces: ["user", "artifact", "clipboard", "downloads", "links", "db", "assets"],
        },
      },
    });
    expect(
      (await ask("coforge/call", { namespace: "comments", method: "open", args: { anchor: "a" } }))
        ?.error?.code,
    ).toBe(-32601);

    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: { jsonrpc: "2.0", method: "ui/notifications/initialized" },
    });
    expect(initializedCount).toBe(1);

    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: 520, height: 310 },
      },
    });
    await bridge.handle({
      source: frameWindow as unknown as MessageEventSource,
      origin: ORIGIN,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { width: -10, height: Number.NaN },
      },
    });
    expect(sizes).toEqual([{ width: 520, height: 310 }]);

    frameWindow.posted.length = 0;
    bridge.notifyTheme();
    expect(frameWindow.posted[0]?.message).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", displayMode: "inline", tokens },
    });
  });

  test("runtime source supports displayMode, --coforge-* theme tokens, inline defaults, viewport-stage sizing, and post-init sizing", () => {
    const source = pageRuntimeSource();
    expect(source).toContain("data-display-mode");
    expect(source).toContain("__coforge-inline-defaults");
    expect(source).toContain("--coforge-");
    expect(source).toContain("if (!initialized) return;");
    expect(source).toContain("detectViewportStage");
    expect(source).toContain("hasViewportHeightRule");
    expect(source).not.toContain("\b");
    expect(() => new Function(source)).not.toThrow();
    const regexMatch = /var VIEWPORT_UNIT = (\/.+\/[a-z]*);/.exec(source);
    expect(regexMatch).not.toBeNull();
    const viewportUnit = new Function(`return ${regexMatch![1]};`)() as RegExp;
    expect(viewportUnit.test("100%")).toBe(true);
    expect(viewportUnit.test("100% !important")).toBe(true);
    expect(viewportUnit.test("calc(100% - 10px)")).toBe(true);
    expect(viewportUnit.test("100vh")).toBe(true);
    expect(viewportUnit.test("100dvh")).toBe(true);
    expect(viewportUnit.test("200px")).toBe(false);
    expect(viewportUnit.test("50%")).toBe(false);
    expect(source).toContain("ui/notifications/size-changed");
  });
});
