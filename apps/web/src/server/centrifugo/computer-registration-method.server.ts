import {
  decodeComputerListRequest,
  encodeComputerListResponse,
  decodeComputerRegisterRequest,
  encodeComputerRegisterResponse,
} from "@lrm/coforge-sdk/internal";

import { ComputerRegistrationError } from "#src/server/computers/registration.server";
import { ComputerRosterError } from "#src/server/computers/roster.server";
import type { CentrifugoRpcMethod, CentrifugoRpcMetadata } from "./rpc-types.server";

function userPrincipal({ principal }: CentrifugoRpcMetadata) {
  return principal.userId
    ? {
        userId: principal.userId,
        // An attach token's bound workspace and the session it is consumed against pass through
        // (task #417); a daemon principal's empty-string workspaceId means none.
        workspaceId: principal.workspaceId || undefined,
        attachSessionId: principal.attachSessionId,
      }
    : undefined;
}

/**
 * `computer:v1:register` — a one-shot attach token or a login resolves to its user (and the
 * token's bound workspace and attach session), and the use case decides; its own
 * `ComputerRegistrationError` is the refusal's wire shape, anything else throws.
 */
export function createComputerRegistrationMethod(useCase: {
  register: (
    request: import("@lrm/coforge-sdk/internal").ComputerRegisterRequest,
    principal: { userId: string; workspaceId?: string; attachSessionId?: string } | undefined,
  ) => Promise<import("@lrm/coforge-sdk/internal").ComputerRegisterResponse>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    try {
      const request = decodeComputerRegisterRequest(payload);
      const result = await useCase.register(request, userPrincipal(metadata));
      return encodeComputerRegisterResponse(result);
    } catch (error) {
      if (error instanceof ComputerRegistrationError)
        return { code: error.code, message: error.message };
      throw error;
    }
  };
}

export function createComputerRosterMethod(useCase: {
  list: (
    request: import("@lrm/coforge-sdk/internal").ComputerListRequest,
    principal: { userId: string } | undefined,
  ) => Promise<import("@lrm/coforge-sdk/internal").ComputerListResponse>;
}): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    try {
      const result = await useCase.list(
        decodeComputerListRequest(payload),
        userPrincipal(metadata),
      );
      return encodeComputerListResponse(result);
    } catch (error) {
      if (error instanceof ComputerRosterError) return { code: error.code, message: error.message };
      throw error;
    }
  };
}
