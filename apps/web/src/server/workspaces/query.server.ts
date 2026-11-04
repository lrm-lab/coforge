import { WORKSPACE_PROTOCOL_MAJOR, type Workspace } from "@lrm/coforge-sdk/internal";
import {
  decodeWorkspaceGetRequest,
  decodeWorkspaceListRequest,
  encodeWorkspaceGetResponse,
  encodeWorkspaceListResponse,
} from "@lrm/coforge-sdk/internal";

export type AuthenticatedPrincipal = {
  readonly userId: string;
  /** Set by a one-shot attach token: the workspace its approval bound, so `workspace:get`
   * resolves that one rather than a caller-supplied slug (task #417). */
  readonly workspaceId?: string;
  /** Set by a one-shot attach token — which buys only `computer:register`. A `workspace.get` or
   * `list` that sees it refuses outright, so merely looking never burns the token. */
  readonly attachSessionId?: string;
};
export interface WorkspaceAccess {
  listAccessible(principal: AuthenticatedPrincipal): Promise<Workspace[]>;
  getAccessibleBySlug(
    slug: string,
    principal: AuthenticatedPrincipal,
  ): Promise<Workspace | undefined>;
  getAccessibleById?(id: string, principal: AuthenticatedPrincipal): Promise<Workspace | undefined>;
}
export class WorkspaceQueryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export class WorkspaceQueryUseCase {
  constructor(private readonly access: WorkspaceAccess) {}
  list(request: ReturnType<typeof decodeWorkspaceListRequest>, principal?: AuthenticatedPrincipal) {
    if (!principal?.userId) throw new WorkspaceQueryError(401, "authentication required");
    if (principal.attachSessionId)
      throw new WorkspaceQueryError(403, "attach token is not a workspace credential");
    if (request.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR || !request.requestId)
      throw new WorkspaceQueryError(422, "invalid workspace request");
    return this.access.listAccessible(principal).then((workspaces) =>
      encodeWorkspaceListResponse({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaces,
      }),
    );
  }
  get(request: ReturnType<typeof decodeWorkspaceGetRequest>, principal?: AuthenticatedPrincipal) {
    if (!principal?.userId) throw new WorkspaceQueryError(401, "authentication required");
    if (request.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR || !request.requestId)
      throw new WorkspaceQueryError(422, "invalid workspace request");
    // A one-shot attach token buys only `computer:register`; `workspace.get` refuses it rather
    // than spend the single use it is for.
    if (principal.attachSessionId)
      throw new WorkspaceQueryError(403, "attach token is not a workspace credential");
    // A one-shot attach token names its bound workspace itself; a slug then is not required —
    // and the token's binding, not a caller-supplied slug, decides which one answers (task #417).
    const resolved = principal.workspaceId
      ? this.access.getAccessibleById?.(principal.workspaceId, principal)
      : request.workspaceSlug
        ? this.access.getAccessibleBySlug(request.workspaceSlug, principal)
        : Promise.resolve(undefined);
    return Promise.resolve(resolved).then((workspace) => {
      if (!workspace) throw new WorkspaceQueryError(404, "workspace not found");
      return encodeWorkspaceGetResponse({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspace,
      });
    });
  }
}
