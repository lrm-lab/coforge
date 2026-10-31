import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { errorResponse } from "./agent-http-error.server";

/**
 * Maps a target-resolution failure to the Agent API's status contract, by `AppError` code:
 * `INVALID_TARGET`/`INVALID_INPUT` for a malformed `#channel` or `@…` grammar and
 * `ACCESS_DENIED`/`TARGET_NOT_ACCESSIBLE` for one the Agent cannot reach (a channel it is not a
 * member of, an unknown username, no usable Agent, a direct-message scope outside the
 * Workspace). `DM_PEER_NOT_IN_WORKSPACE` is a post refusal answered by
 * `dmPeerNotInWorkspaceResponse`, not here.
 *
 * The attachment upload and attachment-upload-session routes reach it through
 * `resolveAttachmentConversation`, so the contract is stated once instead of a copy mirrored
 * between them.
 */
function targetResolutionStatus(error: unknown): number {
  if (isAppErrorCode(error, "ACCESS_DENIED", "TARGET_NOT_ACCESSIBLE")) return 403;
  if (isAppErrorCode(error, "INVALID_TARGET", "INVALID_INPUT")) return 400;
  // An AppError that names no target case (an internal or unavailable failure) maps through the
  // boundary, not as a target refusal.
  if (isAppError(error)) throw error;
  // An unclassified failure reads the same to the caller as a target it cannot reach: unknown
  // and unreachable answer alike.
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
 * The answer to an Agent posting to a well-formed target it cannot reach: an unknown username,
 * no usable Agent, or a direct-message scope outside the Workspace — all `TARGET_NOT_ACCESSIBLE`,
 * so the send reveals neither, exactly the way `targetResolutionStatus` groups them for the
 * attachment routes. Undefined for any other error.
 */
function targetNotAccessibleRefusal(error: unknown) {
  if (!isAppErrorCode(error, "TARGET_NOT_ACCESSIBLE")) return undefined;
  return targetNotAccessibleResponse(403);
}

/**
 * The answer to a target that is not even well-formed: `parsePeerTarget`'s `@…` grammar refuses
 * with `INVALID_TARGET` — a bad request, the same status `targetResolutionStatus` gives it for
 * the attachment routes. Undefined for any other error.
 */
function invalidTargetRefusal(error: unknown) {
  if (!isAppErrorCode(error, "INVALID_TARGET")) return undefined;
  return Response.json({ error: "invalid message target" }, { status: 400 });
}

/**
 * The answer to an Agent posting (a message or an attachment) to a direct message whose person is
 * not a member of the Workspace: `resolveAgentSendTarget` refuses it with
 * `DM_PEER_NOT_IN_WORKSPACE`. Undefined for any other error.
 */
function dmPeerNotInWorkspaceResponse(error: unknown, target: string) {
  if (!isAppErrorCode(error, "DM_PEER_NOT_IN_WORKSPACE")) return undefined;
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
  if (!isAppErrorCode(error, "AMBIGUOUS_TARGET")) return undefined;
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
 * that is malformed, each named by the code its `AppError` carries: a person who left
 * (`DM_PEER_NOT_IN_WORKSPACE`), a bare `@name` that names two (`AMBIGUOUS_TARGET`), an unknown
 * username and someone outside the Workspace, which read alike (`TARGET_NOT_ACCESSIBLE`), or a
 * bad `@…` grammar (`INVALID_TARGET`, a 400 `invalid message target`). Undefined for any other
 * error.
 */
export function postingTargetRefusalResponse(error: unknown, target: string) {
  return (
    dmPeerNotInWorkspaceResponse(error, target) ??
    ambiguousTargetResponse(error, target) ??
    targetNotAccessibleRefusal(error) ??
    invalidTargetRefusal(error)
  );
}
