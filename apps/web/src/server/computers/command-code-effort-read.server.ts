import type {
  DaemonRuntimeCommandCodeEffortReadRequest,
  DaemonRuntimeCommandCodeEffortReadResponse,
} from "@lrm/coforge-sdk/internal";

type EffortResults = {
  begin(pending: {
    request: DaemonRuntimeCommandCodeEffortReadRequest;
    userId: string;
    revision: string;
  }): Promise<void>;
  read(requestId: string): Promise<DaemonRuntimeCommandCodeEffortReadResponse | undefined>;
  clear(requestId: string): Promise<void>;
};

/** The CLI read is 30 seconds, with room for the daemon reply. */
export const COMMAND_CODE_EFFORT_READ_TIMEOUT_MS = 40_000;

export type CommandCodeEffortFormResult =
  | { status: "ready"; efforts: string[] }
  | { status: "failed" };

/** Waits for this Computer's reply for one model. Pending is the call itself, not a status. */
export class CommandCodeEffortRead {
  constructor(
    private readonly dependencies: {
      publish(request: DaemonRuntimeCommandCodeEffortReadRequest): Promise<void>;
      results: EffortResults;
      authorize?: (
        viewer: { userId: string; workspaceId: string },
        computerId: string,
      ) => Promise<boolean>;
    },
    private readonly timing = {
      now: Date.now,
      wait: () => Bun.sleep(100),
      timeoutMs: COMMAND_CODE_EFFORT_READ_TIMEOUT_MS,
    },
  ) {}

  async execute(
    viewer: { userId: string; workspaceId: string },
    computerId: string,
    modelId: string,
  ): Promise<CommandCodeEffortFormResult> {
    const request: DaemonRuntimeCommandCodeEffortReadRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId,
      modelId,
    };
    const { results, publish } = this.dependencies;
    if (!((await this.dependencies.authorize?.(viewer, computerId)) ?? true))
      return { status: "failed" };
    const deadline = this.timing.now() + this.timing.timeoutMs;
    try {
      await results.begin({ request, userId: viewer.userId, revision: "" });
      await publish(request);
      do {
        const result = await results.read(request.requestId);
        if (result) return formResult(result);
        await this.timing.wait();
      } while (this.timing.now() < deadline);
      return { status: "failed" };
    } catch {
      return { status: "failed" };
    } finally {
      await results.clear(request.requestId).catch(() => {});
    }
  }
}

function formResult(
  result: DaemonRuntimeCommandCodeEffortReadResponse,
): CommandCodeEffortFormResult {
  if (!result.accepted || result.status !== "ready") return { status: "failed" };
  return {
    status: "ready",
    efforts: result.efforts.filter((effort) => effort.length > 0 && effort !== "default"),
  };
}
