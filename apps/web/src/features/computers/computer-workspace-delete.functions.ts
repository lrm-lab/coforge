import { createServerFn } from "@tanstack/react-start";
import { deleteAgentWorkspaceInputSchema } from "./computer.schemas";
import { declareNoStore } from "#src/features/no-store-response.server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AppError } from "#src/lib/app-error";
import {
  computerWorkspaceFilesQuery,
  findOwnedWorkspaceComputer,
} from "#src/server/computers/computer-workspace-files.server";

/**
 * Deletes one Agent's workspace on a Computer. Every way it can fail is named, because the dialog
 * shows the reason: the Computer is offline, it did not answer, something still uses the
 * workspace, or it refused the deletion itself.
 */
export const deleteAgentWorkspace = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(deleteAgentWorkspaceInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    const computer = await findOwnedWorkspaceComputer(db, {
      userId: user.id,
      workspaceId,
      computerId: data.computerId,
    });
    const query = computerWorkspaceFilesQuery(db, computer.id, { list: false });
    const response = await query.delete({ userId: user.id, workspaceId }, data.agentId);
    if (response.status !== "ready")
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId:
          response.status === "offline"
            ? "agent-workspace-delete-offline"
            : "agent-workspace-delete-timeout",
      });
    switch (response.result.status) {
      case "ok":
      case "missing":
        return response.result;
      case "busy":
        throw new AppError("INVALID_INPUT", { errorId: "agent-workspace-delete-busy" });
      case "denied":
        throw new AppError("INVALID_INPUT", { errorId: "agent-workspace-delete-denied" });
      default:
        throw new AppError("INVALID_INPUT", { errorId: "agent-workspace-delete-failed" });
    }
  });
