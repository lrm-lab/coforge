import {
  createPageBridge,
  type PageBridgeHost,
  type PageConfirm,
  type PageDataCall,
} from "../../src/features/artifacts/artifact-page-bridge";

type Hooks = Window & Record<string, unknown>;
const hooks = window as unknown as Hooks;
const params = new URLSearchParams(location.search);
const errors: string[] = [];
hooks.__errors = errors;

type Document = { collection: string; id: string; data: unknown; version: number };
const store = new Map<string, Document>();
const stored: { name: string; sizeBytes: number }[] = [];
const changed = new Set<(collection: string) => void>();
const confirms: PageConfirm[] = [];
hooks.__store = () => [...store.values()];
hooks.__confirms = confirms;

const collectionOf = (collection: string) =>
  [...store.values()].filter((doc) => doc.collection === collection);

async function dataCall(call: PageDataCall): Promise<unknown> {
  if (call.method === "get")
    return { document: store.get(`${call.collection}/${call.id}`) ?? null };
  if (call.method === "query") return { documents: collectionOf(call.collection), next: null };
  const touched = new Set<string>();
  const results = call.writes.map((write) => {
    const key = `${write.collection}/${write.id}`;
    touched.add(write.collection);
    if (write.op === "delete") {
      store.delete(key);
      return { collection: write.collection, id: write.id, deleted: true };
    }
    const version = (store.get(key)?.version ?? 0) + 1;
    store.set(key, { collection: write.collection, id: write.id, data: write.data, version });
    return { collection: write.collection, id: write.id, version };
  });
  for (const collection of touched) for (const listener of changed) listener(collection);
  return { results };
}

const dataPort = {
  call: dataCall,
  subscribe: (listener: (collection: string) => void) => {
    changed.add(listener);
    return () => void changed.delete(listener);
  },
};

const assetsPort = {
  list: async () => ({ assets: stored.map((asset) => ({ ...asset, contentType: "text/plain" })) }),
  upload: async (file: Blob, name: string) => {
    stored.push({ name, sizeBytes: file.size });
    return { name, sizeBytes: file.size, contentType: "text/plain" };
  },
  delete: async (name: string) => {
    const at = stored.findIndex((asset) => asset.name === name);
    if (at >= 0) stored.splice(at, 1);
    return { deleted: at >= 0 };
  },
};

let decide: ((allowed: boolean) => void) | null = null;

function bridgeFor(
  frame: HTMLIFrameElement,
  viewer: { displayName: string; kind: "person" },
  level: PageBridgeHost["level"],
  confirm: PageBridgeHost["confirm"],
) {
  const bridge = createPageBridge(
    {
      viewer,
      artifact: {
        id: params.get("artifact") ?? "",
        title: "Probe",
        version: 1,
        entryPath: "index.html",
      },
      level,
      data: dataPort,
      assets: assetsPort,
      theme: () => (hooks.__theme === "dark" ? "dark" : "light"),
      userActive: () => navigator.userActivation.isActive,
      copyText: async (text) => {
        hooks.__copied = text;
        return true;
      },
      downloadFile: () => {},
      confirm,
      openLink: (url) => {
        hooks.__opened = url;
      },
      suggestComment: (request) => {
        hooks.__composer = request;
        return true;
      },
      reportError: (message) => errors.push(message),
      reportFind: (result) => {
        hooks.__find = result;
      },
      frameStatus: (status) => {
        hooks.__blocked = status;
      },
      now: () => Date.now(),
    },
    { origin: params.get("origin") ?? "", window: () => frame.contentWindow },
  );
  window.addEventListener("message", (event) => void bridge.handle(event));
  return bridge;
}

const frame = document.getElementById("f") as HTMLIFrameElement;
const bridge = bridgeFor(frame, { displayName: "Lin Xia", kind: "person" }, "admin", (request) => {
  confirms.push(request);
  hooks.__confirm = request;
  if (request.kind === "link") hooks.__confirmUrl = request.url;
  return new Promise<boolean>((resolve) => {
    decide = resolve;
  });
});
hooks.__decide = (allowed: boolean) => decide?.(allowed);
hooks.__bridge = bridge;
const annotations: unknown[] = [];
bridge.annotations.listen((event) => annotations.push(event));
hooks.__annotations = annotations;
frame.src = params.get("src") ?? "about:blank";

const second = document.getElementById("f2") as HTMLIFrameElement | null;
if (second) {
  bridgeFor(second, { displayName: "Wen Ji", kind: "person" }, "interact", async () => true);
  second.src = params.get("src2") ?? "about:blank";
}
hooks.__post = (id: string, message: unknown) =>
  (document.getElementById(id) as HTMLIFrameElement).contentWindow?.postMessage(message, "*");
