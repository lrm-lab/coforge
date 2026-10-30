import { getLogger } from "@logtape/logtape";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  diagnosticErrorCode,
  type DaemonRuntimeCommandCodeEffortReadRequest,
} from "@lrm/coforge-sdk/internal";
import { readHostCommandCodeEfforts } from "#src/code-agent/command-code/effort-read";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type CommandCodeEffortReadPorts = Readonly<{
  owner: { workspaceId: string; computerId: string };
  /** This Computer's probe-cache directory; absent only for test discoveries. */
  stateDirectory(): string | undefined;
  /** The Command Code version the effort cache was read with. */
  version(): string | undefined;
  /** Whether `transport` is still the runtime's live transport and the runtime is not stopping. */
  isLive(transport: DaemonConnectionClient): boolean;
}>;

/**
 * Answers the server's Command Code effort reads, one at a time: two forms asking at once must not
 * spawn two provider processes, and each answer goes back on the transport the request arrived on.
 */
export class CommandCodeEffortReads {
  readonly #ports: CommandCodeEffortReadPorts;
  #chain: Promise<void> = Promise.resolve();

  constructor(ports: CommandCodeEffortReadPorts) {
    this.#ports = ports;
  }

  /** Answers one read after every read that arrived before it. */
  read(
    request: DaemonRuntimeCommandCodeEffortReadRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    this.#chain = this.#chain.catch(() => {}).then(() => this.#answer(request, transport));
    return this.#chain;
  }

  async #answer(
    request: DaemonRuntimeCommandCodeEffortReadRequest,
    transport: DaemonConnectionClient,
  ): Promise<void> {
    const owner = this.#ports.owner;
    const scope = {
      request_id: request.requestId,
      workspace_id: owner.workspaceId,
      computer_id: owner.computerId,
    };
    const directory = this.#ports.stateDirectory();
    let result: Awaited<ReturnType<typeof readHostCommandCodeEfforts>>;
    try {
      result = directory
        ? await readHostCommandCodeEfforts(directory, request.modelId, this.#ports.version())
        : { status: "failed", code: "unavailable" };
    } catch (error) {
      logger.warning("Command Code effort read failed", {
        event: "command_code_effort:read_failed",
        ...scope,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
      if (!this.#ports.isLive(transport)) return;
      await transport.sendCommandCodeEffortReadResult?.({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaceId: owner.workspaceId,
        computerId: owner.computerId,
        accepted: false,
        status: "failed",
        efforts: [],
      });
      return;
    }
    if (!this.#ports.isLive(transport)) return;
    if (result.status === "failed") {
      logger.warning("Command Code effort read failed", {
        event: "command_code_effort:read_failed",
        ...scope,
        error_code: result.code,
        outcome: "failed",
      });
    } else {
      logger.info("Command Code effort read completed", {
        event: "command_code_effort:read_completed",
        ...scope,
        effort_count: result.efforts.length,
        outcome: "ok",
      });
    }
    await transport.sendCommandCodeEffortReadResult?.({
      protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
      requestId: request.requestId,
      workspaceId: owner.workspaceId,
      computerId: owner.computerId,
      accepted: result.status === "ready",
      status: result.status,
      efforts: result.status === "ready" ? result.efforts : [],
    });
  }
}
