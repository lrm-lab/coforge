import { asRecord, withDeadline } from "@lrm/coforge-anvil";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import type { CodexUsageHost } from "./host";

/** One Codex app-server, initialized with the experimental API as the usage and reset credit
 * flows need it. */
export type CodexAppServer = {
  /** The `initialize` answer's `userAgent`, `<originator>/<codex version> (…)`. */
  readonly userAgent: unknown;
  /** One request, bounded by the session's deadline. A JSON-RPC error reply rejects. */
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** The signed-in account, best effort: an app-server that predates `account/read`, or any
   * failure of it, reads as no answer, and the flow goes on without the account. */
  readAccount(): Promise<Record<string, unknown> | undefined>;
};

/** A Codex app-server that is spawned but not yet initialized. */
export type CodexAppServerSession = {
  /** Initializes the app-server and answers it ready. A request that fails in `initialize`
   * rejects. */
  start(): Promise<CodexAppServer>;
  /** Ends the app-server, whatever state it is in; never rejects. */
  dispose(): Promise<void>;
};

/**
 * Spawns a Codex app-server in `workingDirectory`. Spawning is synchronous and happens here, so
 * an environment or spawn failure of the host reaches the caller as it always did, outside the
 * flow's own error handling. Each request has `timeoutMs`; `timeoutError` makes the flow's own
 * error for one that outlives it, so the flows keep their own error types. The caller disposes.
 */
export function openCodexAppServer(
  workingDirectory: string,
  options: {
    host: CodexUsageHost;
    command?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    timeoutMs: number;
    timeoutError: () => Error;
  },
): CodexAppServerSession {
  const process = new JsonlProcess(
    options.command ?? [RUNTIME_PROVIDER.CODEX, "app-server"],
    workingDirectory,
    options.host.buildUsageEnvironment(options.environment),
    options.host.processTreeSpawner,
  );
  const request: CodexAppServer["request"] = (method, params) =>
    withDeadline(process.request({ method, params }), options.timeoutMs, options.timeoutError);
  return {
    async start() {
      const initialized = await request("initialize", {
        clientInfo: options.host.usageClientInfo,
        capabilities: { experimentalApi: true },
      });
      await process.send({ method: "initialized", params: {} });
      return {
        userAgent: asRecord(initialized.result)?.userAgent,
        request,
        readAccount: async () => {
          try {
            return asRecord((await request("account/read", {})).result);
          } catch {
            return undefined;
          }
        },
      };
    },
    dispose: () => process.dispose().catch(() => undefined),
  };
}
