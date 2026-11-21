import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createPageBridge,
  type PageBridgeHost,
} from "#src/features/artifacts/artifact-page-bridge";
import { PAGE_THEME_TOKEN_MAP } from "#src/features/artifacts/artifact-page-theme";
import { pageRuntimeSource } from "#src/server/artifacts/artifact-page-runtime.server";
import {
  INLINE_DARK_TOKENS,
  INLINE_LIGHT_TOKENS,
} from "../../../services/artifact-checker/evaluate.mjs";

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
  overrides: Pick<
    PageBridgeHost,
    "themeTokens" | "expanded" | "onInitialized" | "onSizeChanged"
  > = {},
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
  test("inline mode advertises displayMode, expanded state, and theme tokens, omits comments, and handles initialized and size-changed", async () => {
    let initializedCount = 0;
    let isExpanded = false;
    const sizes: { width: number; height: number }[] = [];
    const tokens = { "--coforge-fg": "#101319", "--coforge-brand": "#5d36dc" };
    const { frameWindow, bridge, ask } = createInlineBridge({
      themeTokens: () => tokens,
      expanded: () => isExpanded,
      onInitialized: () => {
        initializedCount += 1;
      },
      onSizeChanged: (size) => sizes.push(size),
    });

    const answer = await ask("ui/initialize", {});
    expect(answer?.result).toMatchObject({
      hostContext: { theme: "dark", displayMode: "inline", expanded: false, tokens },
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

    isExpanded = true;
    frameWindow.posted.length = 0;
    bridge.notifyHostContext();
    expect(frameWindow.posted[0]?.message).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", displayMode: "inline", expanded: true, tokens },
    });

    frameWindow.posted.length = 0;
    bridge.notifyTheme();
    expect(frameWindow.posted[0]?.message).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", displayMode: "inline", expanded: true, tokens },
    });
  });

  test("theme token map stays in exact parity with checker tokens and agent manual", () => {
    const hostTokens = Object.keys(PAGE_THEME_TOKEN_MAP).sort();
    expect(PAGE_THEME_TOKEN_MAP["--coforge-font-sans"]).toBe("--font-body");
    expect(PAGE_THEME_TOKEN_MAP["--coforge-font-mono"]).toBe("--font-mono");
    expect(Object.keys(INLINE_LIGHT_TOKENS).sort()).toEqual(hostTokens);
    expect(Object.keys(INLINE_DARK_TOKENS).sort()).toEqual(hostTokens);

    const manualPath = resolve(
      import.meta.dir,
      "../src/server/agents/manual/topics/artifact-pages.md",
    );
    const manual = readFileSync(manualPath, "utf8");
    const documented = new Set(manual.match(/--coforge-[a-z0-9-]+/g) ?? []);
    for (let i = 1; i <= 6; i++) {
      if (documented.has("--coforge-chart-1") && documented.has("--coforge-chart-6")) {
        documented.add(`--coforge-chart-${i}`);
      }
    }
    expect([...documented].sort()).toEqual(hostTokens);
  });

  test("runtime source supports displayMode, expanded state, themeChanged guard, --coforge-* theme and font tokens, inline defaults, viewport-stage sizing, and post-init sizing", () => {
    const source = pageRuntimeSource();
    expect(source).toContain("data-display-mode");
    expect(source).toContain("data-expanded");
    expect(source).toContain("coforge:display");
    expect(source).toContain("var currentTheme = null;");
    expect(source).toContain("if (themeChanged)");
    expect(source).toContain("__coforge-inline-defaults");
    expect(source).toContain("--coforge-font-sans");
    expect(source).toContain("font-size:14px");
    expect(source).toContain("value.length <= 256");
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
