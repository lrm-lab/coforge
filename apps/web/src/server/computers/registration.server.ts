import {
  COMPUTER_REGISTER_PROTOCOL_MAJOR,
  type ComputerRegisterRequest,
  type ComputerRegisterResponse,
} from "@lrm/coforge-sdk/internal";

export type AuthenticatedPrincipal = {
  readonly userId: string;
  /** Set by a one-shot attach token: the workspace its approval bound, so the token — not the
   * request's `workspaceSlug` — decides where the machine lands (task #417). */
  readonly workspaceId?: string;
  /** Set by a one-shot attach token: the session it is consumed against inside the register
   * transaction, so a path that only looks at it (`workspace.get`) never burns it. */
  readonly attachSessionId?: string;
};
export type Workspace = { readonly id: string; readonly slug: string };
export type ComputerRegistration = {
  readonly computerId: string;
  readonly workspaceId: string;
  readonly daemonApiKey: string;
};

export interface WorkspaceAccess {
  findAccessibleBySlug(
    slug: string,
    principal: AuthenticatedPrincipal,
  ): Promise<Workspace | undefined>;
  /** By id — the one-shot attach's token names the workspace its approval bound. */
  findAccessibleById?(
    id: string,
    principal: AuthenticatedPrincipal,
  ): Promise<Workspace | undefined>;
}
export interface ComputerRegistrationRepository {
  register(input: {
    principal: AuthenticatedPrincipal;
    workspace: Workspace;
    request: ComputerRegisterRequest;
  }): Promise<ComputerRegistration>;
}

export class ComputerRegistrationError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class ComputerRegistrar {
  constructor(
    private readonly deps: {
      workspaceAccess: WorkspaceAccess;
      registrations: ComputerRegistrationRepository;
    },
  ) {}

  async register(
    request: ComputerRegisterRequest,
    principal: AuthenticatedPrincipal | undefined,
  ): Promise<ComputerRegisterResponse> {
    if (!principal?.userId) throw new ComputerRegistrationError(401, "authentication required");
    validate(request, principal);
    const workspace = principal.workspaceId
      ? await this.deps.workspaceAccess.findAccessibleById?.(principal.workspaceId, principal)
      : await this.deps.workspaceAccess.findAccessibleBySlug(request.workspaceSlug, principal);
    if (!workspace) throw new ComputerRegistrationError(403, "workspace access denied");
    // A one-shot token binds the workspace its approval chose; a body naming another is refused
    // outright — the token, not the caller's slug, decides where the machine lands. Comparing
    // the body to the bound workspace's own slug covers one the caller cannot even see.
    if (principal.workspaceId && request.workspaceSlug && request.workspaceSlug !== workspace.slug)
      throw new ComputerRegistrationError(403, "attach token bound to another workspace");
    const registration = await this.deps.registrations.register({
      principal,
      workspace,
      request,
    });
    return {
      ...registration,
      // The one-shot attach never named a slug — the token's bound workspace supplies it, so
      // the machine can save its registration locally without a `workspace.get` it is refused.
      workspaceSlug: workspace.slug,
      protocolMajor: COMPUTER_REGISTER_PROTOCOL_MAJOR,
      requestId: request.requestId,
    };
  }
}

function validate(request: ComputerRegisterRequest, principal: { workspaceId?: string }) {
  if (
    request.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR ||
    !request.requestId ||
    // A one-shot attach sends no slug — the token's bound workspace names it; the ordinary
    // path must still name one (task #417).
    !(request.workspaceSlug || principal.workspaceId) ||
    !request.name.trim() ||
    request.name.length > 200 ||
    !request.displayName.trim() ||
    request.displayName.length > 200 ||
    !request.machineId ||
    !request.registrationIdempotencyKey
  )
    throw new ComputerRegistrationError(422, "invalid registration request");
}
