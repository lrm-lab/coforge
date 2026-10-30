import { APP_ERROR_HTTP_STATUS, isAppError } from "#src/lib/app-error";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";
import { ComputerRegistrationError } from "#src/server/computers/registration.server";
import { WorkspaceQueryError } from "#src/server/workspaces/query.server";
import { errorType } from "#src/server/errors/error-type.server";

export type HandledRequestError = { code: number; message: string };
export class RequestAuthenticationError extends Error {}

export function handleRequestError(error: unknown): HandledRequestError {
  if (error instanceof ComputerRegistrationError || error instanceof WorkspaceQueryError)
    return { code: error.code, message: error.message };
  if (error instanceof AgentMessageValidationError) return { code: 400, message: error.message };
  if (error instanceof RequestAuthenticationError)
    return { code: 401, message: "authentication required" };
  if (error instanceof MessageRequestInProgressError) return { code: 409, message: error.message };
  if (isAppError(error)) return { code: APP_ERROR_HTTP_STATUS[error.code], message: error.message };
  console.error(
    JSON.stringify({
      event: "server_request_failed",
      errorType: errorType(error),
    }),
  );
  return { code: 500, message: "RPC method failed" };
}
