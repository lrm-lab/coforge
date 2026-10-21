import { z } from "zod";

const id = z.uuid();
export const piChatCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
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
  }),
  z.object({ action: z.literal("stop"), sessionId: id }),
  z.object({
    action: z.literal("rename"),
    sessionId: id,
    title: z.string().trim().min(1).max(120),
  }),
  z.object({ action: z.literal("delete"), sessionId: id }),
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
});
export type PiChatSession = z.infer<typeof piChatSessionSchema>;

export const piChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
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
  sessions: z.array(piChatSessionSchema).optional(),
  session: piChatSessionSchema.optional(),
  messages: z.array(piChatMessageSchema).optional(),
  before: z.number().int().nonnegative().optional(),
  ok: z.boolean().optional(),
});
export type PiChatResult = z.infer<typeof piChatResultSchema>;
