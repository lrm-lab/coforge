import { z } from "zod";

export const PI_CHAT_SHUTDOWN_GRACE_MS = 30_000;

const id = z.uuid();
export const piChatModelSchema = z.object({
  provider: z.string().min(1).max(200),
  id: z.string().min(1).max(500),
});
export type PiChatModel = z.infer<typeof piChatModelSchema>;
export const piChatQueueSchema = z.object({
  steering: z.array(z.string()),
  followUp: z.array(z.string()),
});
export type PiChatQueue = z.infer<typeof piChatQueueSchema>;
export const piChatProgressSchema = z.object({
  phase: z.enum(["waiting", "thinking", "answering", "tool", "retrying", "compacting"]),
  updatedAt: z.number(),
  toolName: z.string().optional(),
});
export type PiChatProgress = z.infer<typeof piChatProgressSchema>;
export const piChatCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("models") }),
  z.object({ action: z.literal("take_queue"), sessionId: id }),
  z.object({
    action: z.literal("read"),
    sessionId: id,
    before: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal("start"),
    sessionId: id.optional(),
    requestId: id,
    message: z.string().trim().min(1).max(100_000),
    mode: z.enum(["steer", "followUp"]).optional(),
    model: piChatModelSchema.optional(),
  }),
  z.object({ action: z.literal("stop"), sessionId: id }),
  z.object({
    action: z.literal("rename"),
    sessionId: id,
    title: z.string().trim().min(1).max(120),
  }),
  z.object({ action: z.literal("delete"), sessionId: id, stop: z.boolean().optional() }),
]);
export type PiChatCommand = z.infer<typeof piChatCommandSchema>;

export const piChatScopeSchema = z.object({ computerId: id, workspaceId: id, userId: id });
export type PiChatScope = z.infer<typeof piChatScopeSchema>;

export const piChatSessionSchema = z.object({
  id,
  title: z.string(),
  updatedAt: z.number(),
  status: z.enum(["idle", "running", "stopped", "interrupted", "error"]),
  model: z.string(),
  requestIds: z.array(id),
  heldQueue: piChatQueueSchema.optional(),
  interruptedInputs: z
    .array(
      z.object({ id, text: z.string().min(1).max(100_000), mode: z.enum(["steer", "followUp"]) }),
    )
    .optional(),
});
export type PiChatSession = z.infer<typeof piChatSessionSchema>;

export const piChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  details: z.string().optional(),
  thinking: z.string().optional(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.string() })).optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  parentToolCallId: z.string().optional(),
});
export type PiChatMessage = z.infer<typeof piChatMessageSchema>;
export const piChatResultSchema = z.object({
  stream: z.object({ id: z.uuid(), sequence: z.number().int().nonnegative() }).optional(),
  sessions: z.array(piChatSessionSchema).optional(),
  session: piChatSessionSchema.optional(),
  messages: z.array(piChatMessageSchema).optional(),
  before: z.number().int().nonnegative().optional(),
  models: z.array(piChatModelSchema.extend({ name: z.string() })).optional(),
  queue: piChatQueueSchema.optional(),
  takenQueue: piChatQueueSchema.optional(),
  progress: piChatProgressSchema.optional(),
  ok: z.boolean().optional(),
});
export type PiChatResult = z.infer<typeof piChatResultSchema>;
export const piChatWorkerReplySchema = z.object({
  id: z.uuid(),
  result: piChatResultSchema.optional(),
  error: z.string().optional(),
});

/** Replace only the changed native message, never retransmit the entire conversation per token. */
export const piChatUpdateSchema = z.object({
  sessionId: id,
  session: piChatSessionSchema.optional(),
  messages: z.array(piChatMessageSchema).optional(),
  removeIds: z.array(z.string()).optional(),
  deleted: z.boolean().optional(),
  queue: piChatQueueSchema.optional(),
  progress: piChatProgressSchema.optional(),
});
export type PiChatUpdate = z.infer<typeof piChatUpdateSchema>;
export const piChatEventSchema = piChatUpdateSchema.extend({
  stream: z.object({ id: z.uuid(), sequence: z.number().int().positive() }),
});
export type PiChatEvent = z.infer<typeof piChatEventSchema>;
