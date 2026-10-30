import { workspaceAssistantUser } from "#src/server/agents/workspace-assistant-authority.server";
import { WorkspaceAssistantCommands } from "#src/server/agents/workspace-assistant-commands.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { ConversationTaskSubset } from "#src/features/tasks/conversation-task-subset";
import type { TaskCommand, TaskPrincipal, TaskResult } from "@lrm/coforge-sdk/internal";
import { createTasks, announceSentMessageTask } from "./task-creation.server";
import { createConversationTasks } from "./task-conversation-creation.server";
import { taskConversationsEnabled } from "./task-conversations-gate.server";
import { assignTask, unassignTask } from "./task-assignment.server";
import { amendTask, deleteTask, taskHistory, updateTaskStatus } from "./task-amendments.server";
import { claimTasks, convertOrClaim, unclaimTask } from "./task-claims.server";
import { validateTaskCommand } from "./task-command-validation.server";
import { listConversationTasks, listOwnTasks } from "./task-list.server";
import { recordResourceReceipt } from "./task-resource-receipt.server";
import { resolveTaskScope } from "./task-scope.server";
import type {
  ConversationRef,
  TaskBoardDependencies,
  TaskBoardPorts,
} from "./task-board-ports.server";
import type { FinishedTaskStatus } from "./task-view.server";
import {
  TaskOverviewReads,
  type FinishedTaskFilter,
  type FinishedTaskScope,
  type FinishedTaskWindow,
} from "./task-overview.server";

/** The refusal of `claim --message-id` and `convert` once task conversations are on. */
export const TASK_V2_USE_CREATE = "task_v2_use_create";

/** Canonical authorization and transaction seam for message-backed Tasks. */
export class TaskBoard {
  private readonly overviewReads: TaskOverviewReads;
  private readonly ports: TaskBoardPorts;

  constructor(
    private readonly db: PrismaClient,
    dependencies: TaskBoardDependencies = {},
  ) {
    this.ports = { db, reader: dependencies.reader ?? "people", dependencies };
    this.overviewReads = new TaskOverviewReads(db, {
      listableConversation: (viewer, conversationId) =>
        this.listableConversation(viewer, conversationId),
    });
  }

  /**
   * What the viewer may do on the board beyond the ordinary status transitions: a Workspace owner
   * or admin sets any status (`taskStatusMoveAllowed`). The browser's board reads it so it offers
   * exactly the moves the server accepts, never a 403 for a drag the menu offered.
   */
  async authority(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    return { canSetAnyStatus: membership.role === "owner" || membership.role === "admin" };
  }

  // The Workspace Tasks page's reads live in `TaskOverviewReads`; these keep the board's entry
  // points.
  overview(workspaceId: string, userId: string) {
    return this.overviewReads.overview(workspaceId, userId);
  }

  overviewTask(
    scope: { workspaceId: string; userId: string },
    ref: { conversationId: string; number: number },
  ) {
    return this.overviewReads.overviewTask(scope, ref);
  }

  finishedPage(
    scope: FinishedTaskScope,
    query: {
      status: FinishedTaskStatus;
      window: FinishedTaskWindow;
      cursor?: string | null;
      limit?: number;
    } & FinishedTaskFilter,
  ) {
    return this.overviewReads.finishedPage(scope, query);
  }

  finishedSummary(scope: FinishedTaskScope, query: { window: FinishedTaskWindow }) {
    return this.overviewReads.finishedSummary(scope, query);
  }

  /** The part of one conversation's Tasks its page shows; browser-only, read as `list` allows. */
  conversationTasks(
    viewer: { workspaceId: string; userId: string },
    conversationId: string,
    subset: ConversationTaskSubset,
  ) {
    return this.overviewReads.conversationTasks(viewer, conversationId, subset);
  }

  /** The conversation whose Tasks the viewer may list, as `list` allows; see `TaskListAccess`. */
  private async listableConversation(
    viewer: { workspaceId: string; userId: string },
    conversationId: string,
  ) {
    const conversation = await resolveTaskScope(this.ports, viewer, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      conversationId,
    });
    if (!conversation.member && !conversation.channel) throw new AppError("ACCESS_DENIED");
    return conversation.conversationId;
  }

  async execute(principal: TaskPrincipal, command: TaskCommand): Promise<TaskResult> {
    validateTaskCommand(command);
    if (principal.agentId) {
      const user = await workspaceAssistantUser(this.db, principal.workspaceId, principal.agentId);
      if (user) {
        const target = command.target
          ? await new WorkspaceAssistantCommands(this.db).target(
              { workspaceId: principal.workspaceId, agentId: principal.agentId },
              command.target,
            )
          : undefined;
        return this.execute(
          { workspaceId: principal.workspaceId, userId: user.userId },
          target
            ? { ...command, target: undefined, conversationId: target.conversationId }
            : command,
        );
      }
    }
    if (command.operation === "list" && command.mine && (principal.agentId || principal.userId))
      return listOwnTasks(this.ports, principal, command);
    const scope = await resolveTaskScope(this.ports, principal, command);
    if (scope.channel && !scope.member && command.operation !== "list")
      throw new AppError("ACCESS_DENIED");
    if (!scope.member && !scope.channel) throw new AppError("ACCESS_DENIED");

    if (command.operation === "list")
      return listConversationTasks(this.ports, scope.conversationId, command);
    const member = scope.member!;
    const ports = this.ports;
    const conversations =
      (command.operation === "create" ||
        command.operation === "convert" ||
        command.operation === "claim") &&
      (await taskConversationsEnabled(this.db, principal));
    if (command.operation === "create") {
      if (conversations) return createConversationTasks(ports, scope, member, principal, command);
      // Naming a source message needs task conversations.
      if (command.messageId !== undefined || command.alongside !== undefined)
        throw new AppError("INVALID_INPUT");
      return createTasks(ports, scope, member, principal, command);
    }
    // With task conversations a task is made by `create`, naming its source message; a message is
    // never turned into one.
    if (
      conversations &&
      (command.operation === "convert" || command.messageId || command.messageIds)
    )
      throw new AppError("CONFLICT", { errorId: TASK_V2_USE_CREATE });
    if (command.operation === "convert")
      return convertOrClaim(ports, scope, member, command, false);
    if (command.operation === "claim") return claimTasks(ports, scope, member, command);
    if (command.operation === "unclaim")
      return unclaimTask(ports, scope.conversationId, member, command);
    if (command.operation === "assign") return assignTask(ports, scope, member, command);
    if (command.operation === "unassign") return unassignTask(ports, scope, member, command);
    if (command.operation === "amend")
      return amendTask(ports, scope.conversationId, member, command);
    if (command.operation === "history") return taskHistory(ports, scope.conversationId, command);
    if (command.operation === "delete")
      return deleteTask(ports, scope.conversationId, scope.workspaceId, member, command);
    if (command.operation === "receipt")
      return recordResourceReceipt(ports, scope.conversationId, scope.workspaceId, member, command);
    return updateTaskStatus(ports, scope, member, command);
  }

  /**
   * Publish a sentMessageBecomesTask notice and Task change like create; its fixed notice id
   * makes retries idempotent.
   */
  async announceSentTask(conversation: ConversationRef, messageId: string) {
    return announceSentMessageTask(this.ports, conversation, messageId);
  }
}
