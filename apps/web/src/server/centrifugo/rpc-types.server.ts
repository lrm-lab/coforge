import { RequestAuthenticationError } from "#src/server/errors/request-error-handler.server";

export type CentrifugoRpcRequest = {
  client?: string;
  transport?: string;
  protocol?: string;
  encoding?: string;
  user?: string;
  method?: string;
  data?: unknown;
  b64data?: string;
  meta?: Record<string, unknown>;
};

export type CentrifugoRpcMetadata = {
  principal: AuthenticatedDaemonPrincipal;
  client?: string;
  transport?: string;
  protocol?: string;
  encoding?: string;
};

export type AuthenticatedDaemonPrincipal = {
  userId: string;
  workspaceId: string;
  computerId: string;
  agentId?: string;
  /** A `Bearer at_…` attach token carries the session it is consumed against (task #417). */
  attachSessionId?: string;
};

export type CentrifugoRpcError = {
  code: number;
  message: string;
  category?: string;
};

export class CentrifugoRpcAuthenticationError extends RequestAuthenticationError {}

export type CentrifugoRpcHandlerResult = Uint8Array | CentrifugoRpcError;
export type CentrifugoRpcMethod = (
  payload: Uint8Array,
  metadata: CentrifugoRpcMetadata,
) => CentrifugoRpcHandlerResult | Promise<CentrifugoRpcHandlerResult>;
export type CentrifugoRpcAuthenticate = (
  request: CentrifugoRpcRequest,
  context: Request,
) => AuthenticatedDaemonPrincipal | Promise<AuthenticatedDaemonPrincipal>;
export type CentrifugoProxyAuthorizer = (request: Request) => void | Promise<void>;
