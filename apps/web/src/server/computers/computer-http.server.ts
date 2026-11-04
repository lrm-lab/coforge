import { COMPUTER_REGISTER_METHOD, WORKSPACE_GET_METHOD } from "@lrm/coforge-sdk/internal";

import { authenticateComputerAttach } from "#src/server/computers/computer-attach.server";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  createWorkspaceGetMethod,
} from "#src/server/centrifugo/rpc-handler.server";
import { createComputerRegistrationMethod } from "#src/server/centrifugo/computer-registration-method.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "#src/server/db/repositories/setup.repositories.server";
import { WorkspaceQueryUseCase } from "#src/server/workspaces/query.server";
import { ComputerRegistrar } from "./registration.server";

type Dependencies = {
  authenticate(
    request: Request,
  ): Promise<{ userId: string; workspaceId?: string; attachSessionId?: string } | null>;
  workspaceQuery: WorkspaceQueryUseCase;
  registration: Pick<ComputerRegistrar, "register">;
};

/** Owns the User-authenticated Computer setup/attach HTTPS boundary. */
export function createComputerHttpHandler(dependencies?: Dependencies) {
  const resolved = dependencies ?? productionDependencies();
  if (!resolved) return new CentrifugoRpcHandler({ methods: {} });
  return new CentrifugoRpcHandler({
    methods: {
      [WORKSPACE_GET_METHOD]: createWorkspaceGetMethod(resolved.workspaceQuery),
      [COMPUTER_REGISTER_METHOD]: createComputerRegistrationMethod(resolved.registration),
    },
    authenticateEnvelope: async (_envelope, request) => {
      const principal = await resolved.authenticate(request);
      if (!principal) throw new CentrifugoRpcAuthenticationError();
      // A one-shot attach token keeps the workspace its approval bound (so `computer:register`
      // lands there regardless of the body's slug); a daemon key's workspace comes from the key.
      return {
        ...principal,
        workspaceId: principal.workspaceId ?? "",
        computerId: "",
        attachSessionId: principal.attachSessionId,
      };
    },
  });
}

function productionDependencies(): Dependencies | undefined {
  const db = getDatabaseClient();
  if (!db) return undefined;
  const workspaceAccess = new PrismaWorkspaceAccess(db);
  return {
    // A `Bearer at_…` attach token resolves to its approved user and workspace first; the
    // ordinary login JWT follows, refused where that login was retired (task #417).
    authenticate: (request) => authenticateComputerAttach(request, db),
    workspaceQuery: new WorkspaceQueryUseCase(workspaceAccess),
    registration: new ComputerRegistrar({
      workspaceAccess,
      registrations: new PrismaComputerRegistrationRepository(db),
    }),
  };
}
