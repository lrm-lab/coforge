import type {
  DaemonRuntimeCommandCodeEffortReadRequest,
  DaemonRuntimeCommandCodeEffortReadResponse,
} from "@lrm/coforge-sdk/internal";

type Viewer = { userId: string; workspaceId: string };

type EffortResults = {
  begin(pending: {
    request: DaemonRuntimeCommandCodeEffortReadRequest;
    userId: string;
    revision: string;
  }): Promise<void>;
  read(requestId: string): Promise<DaemonRuntimeCommandCodeEffortReadResponse | undefined>;
};

/** What starting a read tells the page: the request whose answer `read` returns, or a failure with
 * nothing asked of the Computer that is still pending. */
export type CommandCodeEffortStart =
  | { status: "started"; requestId: string }
  | { status: "failed" };

/** What reading a request tells the page: no answer yet, the efforts, or a failure. */
export type CommandCodeEffortAnswer =
  | { status: "pending" }
  | { status: "ready"; efforts: string[] }
  | { status: "failed" };

/**
 * One Command Code model's reasoning efforts, read from a Computer. The Computer can take about 30
 * seconds, and production closes a request idle for about ten, so starting publishes the request
 * and returns at once and the page polls `read`. Both need the runtime to be selectable by the
 * viewer; an answer is returned only for a request that names the caller's Workspace and Computer.
 */
export class CommandCodeEffortRead {
  constructor(
    private readonly dependencies: {
      publish(request: DaemonRuntimeCommandCodeEffortReadRequest): Promise<void>;
      results: EffortResults;
      authorize?: (viewer: Viewer, computerId: string) => Promise<boolean>;
    },
  ) {}

  async start(
    viewer: Viewer,
    input: { computerId: string; modelId: string },
  ): Promise<CommandCodeEffortStart> {
    const { results, publish, authorize } = this.dependencies;
    if (!((await authorize?.(viewer, input.computerId)) ?? true)) return { status: "failed" };
    const request: DaemonRuntimeCommandCodeEffortReadRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: input.computerId,
      modelId: input.modelId,
    };
    try {
      await results.begin({ request, userId: viewer.userId, revision: "" });
      await publish(request);
    } catch {
      // The read changes nothing, so a request that did not go out is simply a failed read; one
      // that did is left to expire.
      return { status: "failed" };
    }
    return { status: "started", requestId: request.requestId };
  }

  /**
   * The Computer's answer to one request. While nothing matching has arrived the answer is
   * pending and nothing else is read; an answer is checked against the viewer's access before it
   * is returned, and is left to expire so a poll that lost the reply can ask again.
   */
  async read(
    viewer: Viewer,
    input: { computerId: string; requestId: string },
  ): Promise<CommandCodeEffortAnswer> {
    const answer = await this.dependencies.results.read(input.requestId);
    if (
      !answer ||
      answer.workspaceId !== viewer.workspaceId ||
      answer.computerId !== input.computerId
    )
      return { status: "pending" };
    if (!((await this.dependencies.authorize?.(viewer, input.computerId)) ?? true))
      return { status: "failed" };
    if (!answer.accepted || answer.status !== "ready") return { status: "failed" };
    return {
      status: "ready",
      efforts: answer.efforts.filter((effort) => effort.length > 0 && effort !== "default"),
    };
  }
}
