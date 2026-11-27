import { z } from "zod";
import { agentConsumptionScopeSchema } from "../internal/agent-consumption";
import { MAX_MESSAGE_SEQUENCE } from "../internal/freshness-decision";

export const AGENT_READ_PROTOCOL = "consume-confirm-v1";

const sequence = z.int().nonnegative().max(MAX_MESSAGE_SEQUENCE);
const identifier = z.string().min(1).max(512);
const pageLimit = 100;

export const agentReadCheckpointSchema = z.strictObject({
  index: z.int().min(1).max(pageLimit),
  through: sequence,
  messageId: identifier.optional(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const agentReadConfirmationSchema = z
  .strictObject({
    page: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_.-]+$/),
    checkpoints: z.array(agentReadCheckpointSchema).min(1).max(pageLimit),
  })
  .refine(({ checkpoints }) =>
    checkpoints.every(
      (checkpoint, index) =>
        checkpoint.index === index + 1 &&
        (index === 0 ||
          (checkpoint.messageId !== undefined &&
            checkpoints[index - 1]!.messageId !== undefined &&
            checkpoint.through >= checkpoints[index - 1]!.through)),
    ),
  );

const readWindow = z
  .strictObject({
    before: identifier.optional(),
    after: identifier.optional(),
    around: identifier.optional(),
    limit: z.int().min(1).max(pageLimit).optional(),
    unread: z.boolean().optional(),
    consume: z.boolean().optional(),
  })
  .refine(
    ({ before, after, around, unread }) =>
      Number(Boolean(before)) +
        Number(Boolean(after)) +
        Number(Boolean(around)) +
        Number(unread === true) <=
      1,
  );

export const agentReadPageRequestSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("message"), target: identifier }),
    z.strictObject({
      kind: z.literal("task"),
      channel: identifier,
      taskNumber: z.int().positive(),
    }),
  ]),
  window: readWindow,
  confirm: agentReadConfirmationSchema.optional(),
});

const confirmation = z.strictObject({
  scope: agentConsumptionScopeSchema.extend({
    agentId: identifier,
    target: identifier,
    channelType: z.enum(["channel", "dm", "thread"]),
  }),
  readThrough: sequence,
});

const protocol = z.literal(AGENT_READ_PROTOCOL);

export const agentReadConfirmResponseSchema = z.object({ protocol, confirmation });

export const agentReadPageResponseSchema = z
  .object({
    protocol,
    readThrough: sequence,
    window: z.looseObject({
      messages: z.array(z.looseObject({ id: identifier, sequence })).max(pageLimit),
    }),
    receipt: agentReadConfirmationSchema.optional(),
    confirmation: confirmation.optional(),
  })
  .refine(({ receipt, readThrough, window }) => {
    if (!receipt) return true;
    const messages = window.messages;
    if (messages.length === 0) {
      return (
        receipt.checkpoints.length === 1 &&
        receipt.checkpoints[0]!.messageId === undefined &&
        receipt.checkpoints[0]!.through > readThrough
      );
    }
    return (
      receipt.checkpoints.length === messages.length &&
      receipt.checkpoints.every(
        (checkpoint, index) =>
          checkpoint.messageId === messages[index]!.id &&
          (messages[index]!.sequence <= readThrough
            ? checkpoint.through === readThrough
            : checkpoint.through >= messages[index]!.sequence) &&
          (index + 1 === messages.length ||
            messages[index + 1]!.sequence <= readThrough ||
            checkpoint.through < messages[index + 1]!.sequence),
      )
    );
  });

export type AgentReadConfirmation = z.infer<typeof agentReadConfirmationSchema>;
export type AgentReadPageRequest = z.infer<typeof agentReadPageRequestSchema>;
export type AgentReadConfirmResponse = z.infer<typeof agentReadConfirmResponseSchema>;
export type AgentReadPageResponse = z.infer<typeof agentReadPageResponseSchema>;
export type AgentReadCheckpoint = z.infer<typeof agentReadCheckpointSchema>;

export type AgentReadRequest =
  | { operation: "page"; body: AgentReadPageRequest }
  | { operation: "confirm"; body: AgentReadConfirmation };
