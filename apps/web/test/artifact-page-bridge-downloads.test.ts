import { describe, expect, test } from "bun:test";
import {
  createPageBridge,
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
  const downloads: { name: string; sizeBytes: number }[] = [];
  const host: PageBridgeHost = {
    level: "view",
    data: { call: async () => ({}), subscribe: () => () => {} },
    assets: { list: async () => ({}), upload: async () => ({}), delete: async () => ({}) },
    viewer: { displayName: "Lin Xia", kind: "person" },
    artifact: { id: "a1", title: "Launch", version: 3, entryPath: "index.html" },
    theme: () => "light",
    userActive: () => true,
    copyText: async () => true,
    downloadFile: (file, name) => downloads.push({ name, sizeBytes: file.size }),
    confirm: async () => true,
    openLink: () => {},
    suggestComment: () => true,
    reportError: () => {},
    reportFind: () => {},
    frameStatus: () => {},
    now: () => 0,
    ...overrides,
  };
  const bridge = createPageBridge(host, { origin: ORIGIN, window: () => frameWindow });
  const call = async (namespace: string, method: string, args?: object) => {
    frameWindow.posted.length = 0;
    await bridge.handle({
      source: frameWindow as MessageEventSource,
      origin: ORIGIN,
      data: { jsonrpc: "2.0", id: 1, method: "coforge/call", params: { namespace, method, args } },
    });
    return (frameWindow.posted as { id?: number }[]).find((message) => message.id === 1) as
      | { id: number; result?: unknown; error?: { code: number; message: string } }
      | undefined;
  };
  return { call, downloads };
}

describe("downloads.save", () => {
  test("requires user activation, sanitizes filenames, and accepts Blob or string", async () => {
    let active = false;
    const { call, downloads } = setup({ userActive: () => active });
    expect(
      (await call("downloads", "save", { file: "a,b\n1,2", name: "report.csv" }))?.error?.code,
    ).toBe(-32000);
    expect(downloads).toEqual([]);

    active = true;
    expect(
      (await call("downloads", "save", { file: "a,b\n1,2", name: "../evil/report.csv" }))?.result,
    ).toEqual({ saved: true, name: "-evil-report.csv", sizeBytes: 7 });

    const blob = new Blob(["hello"], { type: "text/plain" });
    expect((await call("downloads", "save", { file: blob, name: "note.txt" }))?.result).toEqual({
      saved: true,
      name: "note.txt",
      sizeBytes: 5,
    });
    expect(downloads).toEqual([
      { name: "-evil-report.csv", sizeBytes: 7 },
      { name: "note.txt", sizeBytes: 5 },
    ]);

    expect((await call("downloads", "save", { file: "", name: "empty.txt" }))?.error?.code).toBe(
      -32602,
    );
    expect((await call("downloads", "save", { file: "x", name: "..." }))?.error?.code).toBe(-32602);
  });
});
