import { createPageBridge } from "../../src/features/artifacts/artifact-page-bridge";

type Hooks = Window & Record<string, unknown>;
const hooks = window as unknown as Hooks;
const params = new URLSearchParams(location.search);
const frame = document.getElementById("f") as HTMLIFrameElement;
let decide: ((allowed: boolean) => void) | null = null;
const errors: string[] = [];
hooks.__errors = errors;

const bridge = createPageBridge(
  {
    viewer: { displayName: "Lin Xia", kind: "person" },
    artifact: {
      id: params.get("artifact") ?? "",
      title: "Probe",
      version: 1,
      entryPath: "index.html",
    },
    theme: () => (hooks.__theme === "dark" ? "dark" : "light"),
    userActive: () => navigator.userActivation.isActive,
    copyText: async (text) => {
      hooks.__copied = text;
      return true;
    },
    confirmOpenLink: (url) =>
      new Promise<boolean>((resolve) => {
        hooks.__confirmUrl = url;
        decide = resolve;
      }),
    openLink: (url) => {
      hooks.__opened = url;
    },
    openComposer: (options) => {
      hooks.__composer = options;
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
hooks.__decide = (allowed: boolean) => decide?.(allowed);
hooks.__bridge = bridge;
frame.src = params.get("src") ?? "about:blank";
