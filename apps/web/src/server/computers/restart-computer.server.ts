import { encodeComputerRestartIntent } from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import type { ComputerRestartStore } from "./computer-restart-store.server";

export interface ComputerRestartAuthorization {
  canRestart(scope: { userId: string; workspaceId: string; computerId: string }): Promise<boolean>;
}

export class RestartComputer {
  constructor(
    private readonly authorization: ComputerRestartAuthorization,
    /** Whether a live daemon is on the Computer's control channel right now; a publish into an
     * empty channel is dropped unheard, so an offline Computer is refused before a record exists. */
    private readonly online: (scope: {
      workspaceId: string;
      computerId: string;
    }) => Promise<boolean>,
    private readonly publisher: Pick<CentrifugoServerApi, "publish">,
    private readonly restarts: ComputerRestartStore,
  ) {}

  async execute(
    principal: { userId: string; workspaceId: string },
    input: { computerId: string; requestId: string },
  ) {
    const scope = { ...principal, computerId: input.computerId };
    if (!(await this.authorization.canRestart(scope))) throw new Error("Computer is not available");
    // Idempotency before liveness, as an upgrade's: the restart itself takes the daemon down,
    // so a retried requestId must read back its stored status rather than answer offline.
    const existing = await this.restarts.status(scope, input.requestId);
    if (existing) return existing;
    if (!(await this.online(scope))) throw new AppError("COMPUTER_OFFLINE");
    const registered = await this.restarts.begin(scope, input.requestId);
    if (!registered.created) return registered.status;
    try {
      await this.publisher.publish(
        daemonControlChannel(principal.workspaceId, input.computerId),
        encodeComputerRestartIntent({
          protocolMajor: 1,
          ...input,
          workspaceId: principal.workspaceId,
        }),
      );
      return registered.status;
    } catch (error) {
      await this.restarts.publicationFailed(scope, input.requestId);
      throw error;
    }
  }
}
