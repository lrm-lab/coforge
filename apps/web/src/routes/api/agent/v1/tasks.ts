import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import type { TaskPrincipal, TaskResult } from "@lrm/coforge-sdk/internal";
import { agentTaskRequestSchema } from "@lrm/coforge-sdk/internal/agent-task-request";
import {
  agentTaskBoardFreshness,
  executeAgentTaskWithFreshness,
} from "#src/server/agents/agent-task-freshness.server";
import {
  agentTaskPrincipal,
  type AgentTaskPrincipal,
} from "#src/server/tasks/task-principal.server";
import { z } from "zod";
import { AppError } from "#src/lib/app-error";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { TASK_V2_USE_CREATE, TaskBoard } from "#src/server/tasks/task-board.server";
import { AGENT_FACING_ERROR_IDS } from "#src/server/tasks/task-gates.server";
import { taskComputerRefusal } from "#src/server/tasks/task-computer-gate.server";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "#src/features/tasks/task-assignment";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";
import { isExternalAgentPrincipal } from "#src/server/agents/external-agent-credentials.server";
import { agentTaskMemoryRecall } from "#src/server/tasks/task-memory-recall.server";

/** The HTTP status a board refusal's code means. Codes outside this map (workspace/computer
 * invariants the board does not raise) fall through to 500. */
const TASK_REFUSAL_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  CONFLICT: 409,
  TEMPORARILY_UNAVAILABLE: 503,
};

/** What a board refusal tells the Agent: the daemon relays it as written. */
const TASK_REFUSAL_TEXT: Record<string, string> = {
  INVALID_INPUT: "the request was not valid for this operation",
  NOT_FOUND: "the referenced task or message does not exist",
  ACCESS_DENIED: "this agent is not allowed to do that",
  CONFLICT: "the task changed since you last read it; read the Task list again",
  TEMPORARILY_UNAVAILABLE: "the server is temporarily unavailable; retry",
};

/** A board refusal's own sentence for the Agent, when it is one written for Agents. */
const agentFacingHint = (error: AppError) =>
  error.errorId && AGENT_FACING_ERROR_IDS.has(error.errorId) ? error.hint : undefined;

export const taskRequestSchema = agentTaskRequestSchema;

/** The raw HTTP adapter validates JSON shape; the board owns command invariants and authorization. */
export async function handleAgentTaskPost(
  request: Request,
  principal: AgentTaskPrincipal,
  board: {
    execute(principal: TaskPrincipal, command: AgentTaskRequest): Promise<TaskResult>;
  },
  freshness?: Parameters<typeof executeAgentTaskWithFreshness>[0]["freshness"],
  /** Where a create/convert that names no priority is measured from (task #12's rollout gate). */
  client?: { computerId: string; computerVersion(): Promise<string | null> },
  recall?: (task: TaskResult["tasks"][number]) => Promise<TaskResult["relatedMemory"]>,
): Promise<Response> {
  try {
    const command = taskRequestSchema.parse(await readAgentJsonBody(request));
    // Phase one of required priority: an Agent command that never names one is still accepted
    // (it lands `none`), but it is logged with the Computer's version so the rollout gate can
    // see which Computers still send none before the refusal ships.
    if (
      client &&
      command.priority === undefined &&
      (command.operation === "create" || command.operation === "convert")
    ) {
      const computerVersion = await client.computerVersion().catch(() => null);
      console.info(
        JSON.stringify({
          event: "task_priority_absent",
          operation: command.operation,
          workspaceId: principal.workspaceId,
          agentId: principal.agentId,
          computerId: client.computerId,
          computerVersion,
        }),
      );
    }
    const result = await executeAgentTaskWithFreshness({ board, freshness }, principal, command);
    const relatedMemory =
      recall &&
      result.state !== "held" &&
      result.tasks.length === 1 &&
      (command.operation === "show" || command.operation === "claim")
        ? await recall(result.tasks[0]!)
        : undefined;
    return Response.json({
      ...result,
      ...(relatedMemory?.length ? { relatedMemory } : {}),
      idempotencyKey: command.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof AppError && error.errorId === TASK_V2_USE_CREATE)
      return Response.json(
        {
          error:
            "With task conversations a task is made with `coforge task create --message-id <id> --title ...`; a message is not turned into a task or claimed as one.",
          code: "CONFLICT",
        },
        { status: 409 },
      );
    if (error instanceof AppError) {
      // A board refusal is a business outcome, not a malformed request: name its code and give it
      // the HTTP status that code means, so a claim of an already-claimed task is a 409 and not a
      // shapeless 400 the caller can only report as an opaque failure.
      const status = TASK_REFUSAL_STATUS[error.code] ?? 500;
      return Response.json(
        {
          error:
            error.errorId === TASK_ASSIGNMENT_MANAGER_REQUIRED
              ? "Assigning or unassigning someone else requires a Workspace owner or admin."
              : (agentFacingHint(error) ?? TASK_REFUSAL_TEXT[error.code] ?? "task request refused"),
          code: error.code,
        },
        { status },
      );
    }
    if (error instanceof z.ZodError) {
      const invalidEvidence = error.issues.some((issue) => issue.path[0] === "consumptionEvidence");
      return Response.json(
        {
          error: invalidEvidence ? "invalid consumptionEvidence" : "invalid task request",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }
    console.error("[agent] Task command failed", error);
    return Response.json({ error: "Task command failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/agent/v1/tasks")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      // An Agent's Task writes reach open pages like a person's: their notices and Task changes
      // are signalled (never delivered or pushed from here).
      POST: async ({ request, context: { principal, db } }) =>
        (await taskComputerRefusal(db, principal)) ??
        handleAgentTaskPost(
          request,
          // Agent Task commands act as the agent, not its owner user.
          agentTaskPrincipal(principal),
          new TaskBoard(db, {
            // The Agent reads its results: a person mentioned in a title reads as their @handle.
            reader: "agent",
            realtime: new CentrifugoConversationRealtime(createCentrifugoServerApi()),
          }),
          (command) => agentTaskBoardFreshness(db, agentTaskPrincipal(principal), command),
          isExternalAgentPrincipal(principal)
            ? undefined
            : {
                computerId: principal.computerId,
                computerVersion: async () =>
                  (
                    await db.computer.findUnique({
                      where: { id: principal.computerId },
                      select: { computerVersion: true },
                    })
                  )?.computerVersion ?? null,
              },
          agentTaskMemoryRecall(db, agentTaskPrincipal(principal)),
        ),
    },
  },
});
