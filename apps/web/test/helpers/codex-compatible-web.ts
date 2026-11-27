import { AsyncLocalStorage } from "node:async_hooks";
import { createClientRpc } from "@tanstack/react-start/client-rpc";
import { serverFunctionIds } from "./server-function-ids";

const methods = {
  listComputers: "GET",
  getComputerCodexCompatible: "GET",
  createAgent: "POST",
  updateAgent: "POST",
  openDirectConversation: "POST",
  sendDirectConversationMessage: "POST",
  loadDirectConversation: "GET",
  executeAgentControl: "POST",
  readAgentUsage: "GET",
} as const;

const startContext = Reflect.get(globalThis, Symbol.for("tanstack-start:start-storage-context")) as
  | AsyncLocalStorage<{ startOptions: object }>
  | undefined;

export function codexCompatibleWeb(origin: URL, workspaceSlug: string) {
  if (origin.protocol !== "https:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    throw new Error("The Codex E2E requires its disposable HTTPS Web service on loopback");
  }

  const names = Object.keys(methods) as (keyof typeof methods)[];
  const ids = new Map([...serverFunctionIds(names)].map(([id, name]) => [name, id]));
  const context = { workspaceSlug, page: `/en/w/${workspaceSlug}/members` };

  return async function call<T>(name: keyof typeof methods, data?: object): Promise<T> {
    const id = ids.get(name);
    if (!id) throw new Error(`Missing fixture server function ${name}`);

    try {
      if (!startContext) throw new Error("Missing TanStack Start request context");
      const response = await startContext.run({ startOptions: {} }, () =>
        createClientRpc(id)({
          method: methods[name],
          data,
          context,
          fetch: (path: string, init: RequestInit) => {
            const headers = new Headers(init.headers);
            headers.set("origin", origin.origin);
            headers.set("sec-fetch-site", "same-origin");
            return fetch(new URL(`/_serverFn/${id}${new URL(path, origin).search}`, origin), {
              ...init,
              headers,
              redirect: "error",
            });
          },
        }),
      );
      const result = response as { result?: T; error?: unknown } | undefined;
      if (!result || !("result" in result) || result.error) throw new Error();
      return result.result as T;
    } catch {
      throw new Error(`The disposable Web service refused ${name}`);
    }
  };
}

export async function waitForFixtureReply(
  web: ReturnType<typeof codexCompatibleWeb>,
  conversationId: string,
  reply: string,
) {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    const page = await web<{ messages: { id: string; body: string }[] }>("loadDirectConversation", {
      conversationId,
      limit: 20,
    });
    const message = page.messages.find(({ body }) => body.trimEnd() === reply);
    if (message) return message;
    await Bun.sleep(300);
  }
  throw new Error("The disposable Web service did not return the Codex Agent's fixture reply");
}
