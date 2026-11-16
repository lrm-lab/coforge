export type PageTheme = "light" | "dark";

export type PageViewer = { displayName: string; kind: "person" };

export type PageArtifact = { id: string; title: string; version: number; entryPath: string };

export type PageFrameStatus = { state: "blocked"; reason: string; status: number };

export type PageBridgeHost = {
  viewer: PageViewer;
  artifact: PageArtifact;
  theme(): PageTheme;
  userActive(): boolean;
  copyText(text: string): Promise<boolean>;
  confirmOpenLink(url: string): Promise<boolean>;
  openLink(url: string): void;
  openComposer(options: { body?: string }): boolean;
  reportError(message: string): void;
  reportFind(result: { total: number; active: number }): void;
  frameStatus(status: PageFrameStatus): void;
  now(): number;
};

export type PageBridgeFrame = {
  origin: string;
  window(): Window | null;
};

export const BRIDGE_PROTOCOL_VERSION = "2026-01-26";
export const BRIDGE_RATE_LIMIT_PER_MINUTE = 30;
export const BRIDGE_DECLINES_BEFORE_MUTE = 3;
export const BRIDGE_ERROR_REPORTS = 5;
export const BRIDGE_NAMESPACES = ["user", "artifact", "clipboard", "links", "comments"] as const;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const REFUSED = -32000;

type Params = Record<string, unknown>;

class BridgeRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Params =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createPageBridge(host: PageBridgeHost, frame: PageBridgeFrame) {
  const hits = new Map<string, number[]>();
  let declines = 0;
  let errorReports = 0;

  const send = (message: object) =>
    frame.window()?.postMessage({ jsonrpc: "2.0", ...message }, frame.origin);

  const admit = (key: string) => {
    const now = host.now();
    const recent = (hits.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= BRIDGE_RATE_LIMIT_PER_MINUTE) {
      hits.set(key, recent);
      throw new BridgeRefusal(REFUSED, "Too many requests");
    }
    hits.set(key, [...recent, now]);
  };

  const openLink = async (params: Params) => {
    admit("ui/open-link");
    if (declines >= BRIDGE_DECLINES_BEFORE_MUTE) throw new BridgeRefusal(REFUSED, "Muted");
    const url = httpUrl(params.url);
    if (!url) throw new BridgeRefusal(INVALID_PARAMS, "Only http and https links open");
    if (!(await host.confirmOpenLink(url))) {
      declines += 1;
      throw new BridgeRefusal(REFUSED, "Declined");
    }
    host.openLink(url);
    return {};
  };

  const calls: Record<string, (args: Params) => Promise<unknown> | unknown> = {
    "user.get": () => host.viewer,
    "artifact.get": () => host.artifact,
    "clipboard.copy": async (args) => {
      if (typeof args.text !== "string" || args.text.length > 100_000)
        throw new BridgeRefusal(INVALID_PARAMS, "Text expected");
      if (!host.userActive()) throw new BridgeRefusal(REFUSED, "Copy needs a click in the page");
      return { copied: await host.copyText(args.text) };
    },
    "comments.open": (args) => {
      const body = typeof args.body === "string" ? args.body.slice(0, 8000) : undefined;
      return { opened: host.openComposer({ body }) };
    },
  };

  const call = async (params: Params) => {
    const key = `${String(params.namespace)}.${String(params.method)}`;
    const handler = Object.hasOwn(calls, key) ? calls[key] : undefined;
    if (!handler) throw new BridgeRefusal(METHOD_NOT_FOUND, `${key} isn't offered here`);
    admit(key);
    return handler(isRecord(params.args) ? params.args : {});
  };

  const request = async (method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case "ui/initialize":
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          hostInfo: { name: "coforge", version: "1" },
          hostCapabilities: { openLinks: {} },
          hostContext: { theme: host.theme() },
          experimental: { "coforge/runtime": { namespaces: [...BRIDGE_NAMESPACES] } },
        };
      case "ui/open-link":
        return openLink(params);
      case "coforge/call":
        return call(params);
      default:
        throw new BridgeRefusal(METHOD_NOT_FOUND, `${method} isn't offered here`);
    }
  };

  const notify = (method: string, params: Params) => {
    switch (method) {
      case "coforge/notifications/error":
        if (errorReports < BRIDGE_ERROR_REPORTS && typeof params.message === "string") {
          errorReports += 1;
          host.reportError(params.message.slice(0, 500));
        }
        return;
      case "coforge/notifications/find-result":
        if (Number.isSafeInteger(params.total) && Number.isSafeInteger(params.active))
          host.reportFind({ total: Number(params.total), active: Number(params.active) });
        return;
      case "coforge/notifications/frame-status":
        if (params.state === "blocked" && typeof params.reason === "string")
          host.frameStatus({
            state: "blocked",
            reason: params.reason,
            status: Number.isSafeInteger(params.status) ? Number(params.status) : 0,
          });
        return;
      default:
        return;
    }
  };

  return {
    async handle(event: Pick<MessageEvent, "source" | "origin" | "data">) {
      const frameWindow = frame.window();
      if (!frameWindow || event.source !== frameWindow || event.origin !== frame.origin) return;
      const message: unknown = event.data;
      if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string")
        return;
      const params = isRecord(message.params) ? message.params : {};
      if (message.id === undefined) {
        notify(message.method, params);
        return;
      }
      if (typeof message.id !== "number" && typeof message.id !== "string") return;
      try {
        send({ id: message.id, result: await request(message.method, params) });
      } catch (cause) {
        send({
          id: message.id,
          error:
            cause instanceof BridgeRefusal
              ? { code: cause.code, message: cause.message }
              : { code: REFUSED, message: "Failed" },
        });
      }
    },
    notifyTheme() {
      send({ method: "ui/notifications/host-context-changed", params: { theme: host.theme() } });
    },
    find(params: { query: string; step: number }) {
      send({ method: "coforge/find", params });
    },
  };
}

export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
