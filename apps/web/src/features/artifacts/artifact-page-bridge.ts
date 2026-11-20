import {
  BridgeRefusal,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  REFUSED,
  isRecord,
  type BridgeKit,
  type CallTable,
  type ConfirmGate,
  type PageAssetsPort,
  type PageConfirm,
  type PageDataPort,
  type Params,
} from "./artifact-page-bridge-core";
import { createAnnotationChannel } from "./artifact-page-bridge-annotate";
import { createAssetCalls } from "./artifact-page-bridge-assets";
import { createCommentCalls, type PageCommentRequest } from "./artifact-page-bridge-comments";
import { createDataCalls } from "./artifact-page-bridge-data";
import { createDownloadCalls } from "./artifact-page-bridge-downloads";
import {
  PAGE_METHOD_LEVELS,
  levelReaches,
  offeredNamespaces,
  type PageLevel,
} from "./artifact-page-levels";

export { PageHostError } from "./artifact-page-bridge-core";
export type { PageAnnotationEvent } from "./artifact-page-bridge-annotate";
export type { PageCommentRequest, PageSuggestHandler } from "./artifact-page-bridge-comments";
export type {
  PageAssetsPort,
  PageConfirm,
  PageDataCall,
  PageDataPort,
} from "./artifact-page-bridge-core";

export type PageTheme = "light" | "dark";

export type PageViewer = { displayName: string; kind: "person" };

export type PageArtifact = { id: string; title: string; version: number; entryPath: string };

export type PageFrameStatus = { state: "blocked"; reason: string; status: number };

export type PageBridgeHost = {
  viewer: PageViewer;
  artifact: PageArtifact;
  level: PageLevel;
  data: PageDataPort;
  assets: PageAssetsPort;
  theme(): PageTheme;
  userActive(): boolean;
  copyText(text: string): Promise<boolean>;
  downloadFile(file: Blob, name: string): void;
  confirm(request: PageConfirm): Promise<boolean>;
  openLink(url: string): void;
  suggestComment(request: PageCommentRequest): boolean;
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
export const BRIDGE_DATA_RATE_LIMIT_PER_MINUTE = 600;
export const BRIDGE_DECLINES_BEFORE_MUTE = 3;
export const BRIDGE_ERROR_REPORTS = 5;

export const FRAME_STATUS = "coforge/notifications/frame-status";

export function blockedFrameStatus(params: unknown): PageFrameStatus | null {
  if (!isRecord(params)) return null;
  const { state, reason, status } = params;
  if (state !== "blocked" || typeof reason !== "string") return null;
  return { state, reason, status: Number.isSafeInteger(status) ? Number(status) : 0 };
}

export type PageBridge = ReturnType<typeof createPageBridge>;

export function createPageBridge(host: PageBridgeHost, frame: PageBridgeFrame) {
  const hits = new Map<string, number[]>();
  const declines = new Map<ConfirmGate, number>();
  const consents = new Set<ConfirmGate>();
  let errorReports = 0;

  const send = (message: object) =>
    frame.window()?.postMessage({ jsonrpc: "2.0", ...message }, frame.origin);

  const admit = (key: string) => {
    const now = host.now();
    const recent = (hits.get(key) ?? []).filter((at) => now - at < 60_000);
    const limit =
      key.startsWith("db.") || key.startsWith("annotate.")
        ? BRIDGE_DATA_RATE_LIMIT_PER_MINUTE
        : BRIDGE_RATE_LIMIT_PER_MINUTE;
    if (recent.length >= limit) {
      hits.set(key, recent);
      throw new BridgeRefusal(REFUSED, "Too many requests");
    }
    hits.set(key, [...recent, now]);
  };

  const confirm: BridgeKit["confirm"] = async (gate, request, remember = false) => {
    if (remember && consents.has(gate)) return;
    if ((declines.get(gate) ?? 0) >= BRIDGE_DECLINES_BEFORE_MUTE)
      throw new BridgeRefusal(REFUSED, "Muted");
    if (!(await host.confirm(request))) {
      declines.set(gate, (declines.get(gate) ?? 0) + 1);
      throw new BridgeRefusal(REFUSED, "Declined");
    }
    if (remember) consents.add(gate);
  };

  const openLink = async (params: Params) => {
    admit("ui/open-link");
    if ((declines.get("links") ?? 0) >= BRIDGE_DECLINES_BEFORE_MUTE)
      throw new BridgeRefusal(REFUSED, "Muted");
    const url = httpUrl(params.url);
    if (!url) throw new BridgeRefusal(INVALID_PARAMS, "Only http and https links open");
    await confirm("links", { kind: "link", url });
    host.openLink(url);
    return {};
  };

  const annotations = createAnnotationChannel(send, () => host.userActive());

  const kit: BridgeKit = {
    level: host.level,
    data: host.data,
    assets: host.assets,
    send,
    confirm,
  };
  const dataCalls = createDataCalls(kit);

  const calls: CallTable = {
    ...dataCalls.calls,
    ...createAssetCalls(kit),
    "user.get": () => host.viewer,
    "artifact.get": () => host.artifact,
    "clipboard.copy": async (args) => {
      if (typeof args.text !== "string" || args.text.length > 100_000)
        throw new BridgeRefusal(INVALID_PARAMS, "Text expected");
      if (!host.userActive()) throw new BridgeRefusal(REFUSED, "Copy needs a click in the page");
      return { copied: await host.copyText(args.text) };
    },
    ...createDownloadCalls(host),
    ...createCommentCalls(host),
  };

  const call = async (params: Params) => {
    const key = `${String(params.namespace)}.${String(params.method)}`;
    const handler = Object.hasOwn(calls, key) ? calls[key] : undefined;
    if (!handler) throw new BridgeRefusal(METHOD_NOT_FOUND, `${key} isn't offered here`);
    if (!levelReaches(host.level, PAGE_METHOD_LEVELS[key] ?? "owner"))
      throw new BridgeRefusal(REFUSED, "Not allowed");
    admit(key);
    return handler(isRecord(params.args) ? params.args : {});
  };

  const request = async (method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case "ui/initialize":
        admit("ui/initialize");
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          hostInfo: { name: "coforge", version: "1" },
          hostCapabilities: { openLinks: {} },
          hostContext: { theme: host.theme() },
          experimental: { "coforge/runtime": { namespaces: offeredNamespaces(host.level) } },
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
    if (method.startsWith("coforge/notifications/annotate-")) {
      try {
        admit("annotate.notify");
      } catch {
        return;
      }
      annotations.notify(method, params);
      return;
    }
    switch (method) {
      case "ui/notifications/initialized":
        try {
          admit("ui/notifications/initialized");
        } catch {
          return;
        }
        annotations.ready();
        return;
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
      case FRAME_STATUS: {
        const block = blockedFrameStatus(params);
        if (block) host.frameStatus(block);
        return;
      }
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
    dispose() {
      dataCalls.dispose();
    },
    notifyTheme() {
      send({ method: "ui/notifications/host-context-changed", params: { theme: host.theme() } });
    },
    find(params: { query: string; step: number }) {
      send({ method: "coforge/find", params });
    },
    annotations: {
      listen: annotations.listen,
      configure: annotations.configure,
      setMarks: annotations.setMarks,
      setDraft: annotations.setDraft,
      setDrafts: annotations.setDrafts,
      focus: annotations.focus,
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
