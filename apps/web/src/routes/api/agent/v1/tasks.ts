import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import {
  CHANNEL_NAME_PATTERN,
  MAX_MESSAGE_SEQUENCE,
  SEEN_EXACT_SEQS_LIMIT,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPrincipal,
  type TaskResult,
} from "@lrm/coforge-sdk/internal";
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
import { PROJECT_SLUG_MAX_LENGTH } from "#src/features/projects/projects.schemas";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import {
  TASK_MESSAGE_SOURCE_REQUIRES_CONVERSATIONS,
  TASK_V2_USE_CREATE,
  TaskBoard,
} from "#src/server/tasks/task-board.server";
import { AGENT_FACING_ERROR_IDS } from "#src/server/tasks/task-gates.server";
import { taskComputerRefusal } from "#src/server/tasks/task-computer-gate.server";
import { SourceMessageTaken } from "#src/server/tasks/task-conversation-creation.server";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "#src/features/tasks/task-assignment";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";

const taskOperations = [
  "list",
  "show",
  "create",
  "convert",
  "claim",
  "unclaim",
  "update",
  "assign",
  "unassign",
  "amend",
  "history",
  "delete",
  "receipt",
] as const;
const taskStatuses = [...TASK_STATUSES, "all"] as const;

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

/** A Task by number, in this conversation or in the Workspace channel named. */
const taskRefSchema = z
  .object({
    number: z.number().int().positive(),
    channel: z.string().regex(CHANNEL_NAME_PATTERN).optional(),
  })
  .strict();

export const taskRequestSchema = z
  .object({
    operation: z.enum(taskOperations),
    idempotencyKey: z.string().min(1),
    conversationId: z.uuid().optional(),
    target: z.string().min(1).optional(),
    peerKind: z.enum(["human", "agent"]).optional(),
    number: z.number().int().positive().optional(),
    numbers: z.array(z.number().int().positive()).min(1).optional(),
    messageId: z.string().min(1).optional(),
    messageIds: z.array(z.string().min(1)).min(1).optional(),
    title: z.string().min(1).max(10_000).optional(),
    titles: z.array(z.string().min(1).max(10_000)).min(1).optional(),
    description: z.string().max(50_000).nullable().optional(),
    assignee: z.string().nullable().optional(),
    blockedBy: z.array(taskRefSchema).max(100).optional(),
    parent: taskRefSchema.nullable().optional(),
    ready: z.boolean().optional(),
    mine: z.boolean().optional(),
    createsResource: z.boolean().optional(),
    receipt: z
      .object({
        object: z.string().min(1),
        purpose: z.string().min(1),
        teardownOwner: z.string().min(1),
        securityPrivacy: z.string().min(1),
        expiry: z.iso.datetime({ offset: true }),
        runbook: z.string().min(1),
        tracking: z.string().min(1),
      })
      .optional(),
    freshnessContextMode: z.enum(["inline", "withheld"]).optional(),
    seenUpToSeq: z.number().int().nonnegative().max(MAX_MESSAGE_SEQUENCE).optional(),
    seenExactSeqs: z
      .array(z.number().int().positive().max(MAX_MESSAGE_SEQUENCE))
      .max(SEEN_EXACT_SEQS_LIMIT)
      .optional(),
    continueAnyway: z.boolean().optional(),
    alongside: z.boolean().optional(),
    attachmentId: z.uuid().optional(),
    status: z.enum(taskStatuses).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    labels: z.array(z.string().min(1).max(64)).max(5).optional(),
    removeLabels: z.array(z.string().min(1).max(64)).max(5).optional(),
    labelDescription: z.string().min(1).max(500).optional(),
    project: z.string().trim().min(1).max(PROJECT_SLUG_MAX_LENGTH).nullable().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The raw HTTP adapter validates JSON shape; the board owns command invariants and authorization. */
export async function handleAgentTaskPost(
  request: Request,
  principal: AgentTaskPrincipal,
  board: {
    execute(principal: TaskPrincipal, command: AgentTaskRequest): Promise<TaskResult>;
  },
  freshness?: Parameters<typeof executeAgentTaskWithFreshness>[0]["freshness"],
): Promise<Response> {
  try {
    const command = taskRequestSchema.parse(await readAgentJsonBody(request));
    const result = await executeAgentTaskWithFreshness({ board, freshness }, principal, command);
    return Response.json({ ...result, idempotencyKey: command.idempotencyKey });
  } catch (error) {
    if (error instanceof SourceMessageTaken) return agentErrorResponse(error);
    if (error instanceof AppError && error.errorId === TASK_MESSAGE_SOURCE_REQUIRES_CONVERSATIONS)
      return Response.json(
        {
          error:
            "`--message-id` needs task conversations. With them off, run `coforge task convert --target <channel> --message-id <id>` to make this message a task; or ask a Workspace owner to turn task conversations on.",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
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
      return Response.json(
        { error: "invalid task request", code: "INVALID_INPUT" },
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
        ),
    },
  },
});
