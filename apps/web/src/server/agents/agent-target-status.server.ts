import { isAppError } from "#src/lib/app-error";
import { errorResponse } from "./agent-http-error.server";

/**
 * Maps a target-resolution failure to the Agent API's status contract. Resolving a target throws
 * `AppError("INVALID_INPUT")` for a malformed `#channel`, `AppError("ACCESS_DENIED")` for a
 * channel the Agent is not a member of, `AppError("DM_PEER_NOT_IN_WORKSPACE")` for a direct
 * message whose person has left (answered by `dmPeerNotInWorkspaceResponse`, not here), and a
 * plain `Error` for the `@user` grammar (`"invalid message target"`) and for a username that does
 * not exist or belongs to no member this Agent can reach (`"target user not found"`, and
 * `"conversation scope is not authorized"` for an Agent outside the Workspace).
 *
 * The attachment upload and attachment-upload-session routes reach it through
 * `resolveAttachmentConversation`, so the contract is stated once instead of a copy mirrored
 * between them.
 */
function targetResolutionStatus(error: unknown): number {
  if (isAppError(error)) return error.code === "ACCESS_DENIED" ? 403 : 400;
  if (error instanceof Error && error.message === "invalid message target") return 400;
  // "target user not found" / "conversation scope is not authorized": an unknown target or one
  // the Agent cannot reach reads the same to the caller as "not a member".
  return 403;
}

/**
 * `target is not accessible`: the one answer to a target this Agent cannot use, the same for a
 * username that does not exist and for someone outside the Workspace, so it reveals neither.
 */
function targetNotAccessibleResponse(status: number) {
  return errorResponse("TARGET_NOT_ACCESSIBLE", "target is not accessible", status, false);
}

/**
 * The answer to an Agent posting to an `@user` it cannot reach: a username that does not exist
 * (`"target user not found"`) or a direct-message scope outside the Workspace
 * (`"conversation scope is not authorized"`). Both read the same to the caller, so the send
 * reveals neither, exactly the way `targetResolutionStatus` groups them for the attachment
 * routes. Undefined for any other error.
 */
function unreachablePeerResponse(error: unknown) {
  if (
    !(error instanceof Error) ||
    (error.message !== "target user not found" &&
      error.message !== "conversation scope is not authorized")
  )
    return undefined;
  return targetNotAccessibleResponse(403);
}

/**
 * The answer to a target that is not even well-formed: `parsePeerTarget`'s `@…` grammar refuses
 * with `"invalid message target"` — a bad request, the same status `targetResolutionStatus`
 * gives it for the attachment routes. Undefined for any other error.
 */
function invalidMessageTargetResponse(error: unknown) {
  if (!(error instanceof Error) || error.message !== "invalid message target") return undefined;
  return Response.json({ error: "invalid message target" }, { status: 400 });
}

/**
 * The answer to an Agent posting (a message or an attachment) to a direct message whose person is
 * not a member of the Workspace: `resolveAgentSendTarget` refuses it with
 * `DM_PEER_NOT_IN_WORKSPACE`. Undefined for any other error.
 */
function dmPeerNotInWorkspaceResponse(error: unknown, target: string) {
  if (!isAppError(error) || error.code !== "DM_PEER_NOT_IN_WORKSPACE") return undefined;
  return errorResponse(
    error.code,
    `${target.split(":")[0]} is not a member of this Workspace, so this Agent cannot send them a direct message`,
    403,
    false,
  );
}

/**
 * The answer to a bare `@name` that is both a Workspace member and an Agent: the sender picks with
 * `@name~human` or `@name~agent`, so nothing is sent to the wrong one. Undefined for any other
 * error.
 */
export function ambiguousTargetResponse(error: unknown, target: string) {
  if (!isAppError(error) || error.code !== "AMBIGUOUS_TARGET") return undefined;
  const name = target.split(":")[0]!.split("~")[0];
  return errorResponse(
    error.code,
    `${name} names both a person and an Agent in this Workspace; use ${name}~human or ${name}~agent`,
    409,
    false,
  );
}

/**
 * The conversation an attachment upload belongs to, or the refusal to send instead. The
 * attachment belongs to the conversation, not a message, so any `:thread` suffix is dropped
 * rather than resolved, and uploading never depends on a thread anchor already existing. Shared
 * by the multipart upload and upload-session routes.
 */
export async function resolveAttachmentConversation(
  resolveTarget: (
    workspaceId: string,
    agentId: string,
    target: string,
  ) => Promise<{ conversationId: string }>,
  principal: { workspaceId: string; agentId: string },
  target: string,
): Promise<{ conversationId: string } | Response> {
  const parentTarget = target.split(":")[0]!;
  try {
    const { conversationId } = await resolveTarget(
      principal.workspaceId,
      principal.agentId,
      parentTarget,
    );
    return { conversationId };
  } catch (error) {
    return (
      dmPeerNotInWorkspaceResponse(error, parentTarget) ??
      ambiguousTargetResponse(error, parentTarget) ??
      targetNotAccessibleResponse(targetResolutionStatus(error))
    );
  }
}

/**
 * The answer to an Agent posting a message or an action card to a target it cannot reach or one
 * that is malformed: a person who left (`DM_PEER_NOT_IN_WORKSPACE`), an unknown username and
 * someone outside the Workspace, which read alike (`target is not accessible`), or a bad `@…`
 * grammar (a 400 `invalid message target`). Undefined for any other error.
 */
export function postingTargetRefusalResponse(error: unknown, target: string) {
  return (
    dmPeerNotInWorkspaceResponse(error, target) ??
    ambiguousTargetResponse(error, target) ??
    unreachablePeerResponse(error) ??
    invalidMessageTargetResponse(error)
  );
}
