import { z } from "zod";
import { TERMINAL_MAX_DIMENSION } from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { computerIdInputSchema } from "./computer.schemas";

const TERMINAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const computerTerminalAttachScopeSchema = z.object({
  computerId: z.string().min(1),
  sessionId: z.string().regex(TERMINAL_ID_PATTERN),
  attachId: z.string().regex(TERMINAL_ID_PATTERN),
  attachGeneration: z.number().int().min(1).max(0xffff_ffff),
});

export const setComputerTerminalEnabledInputSchema = computerIdInputSchema.extend({
  enabled: z.boolean(),
});

export const prepareComputerTerminalAttachInputSchema = computerIdInputSchema.extend({
  cols: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
  rows: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
  takeover: z.boolean(),
  mode: z.enum(["interactive", "readonly"]),
});

export const activateComputerTerminalAttachInputSchema = computerTerminalAttachScopeSchema.extend({
  cols: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
  rows: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
  takeover: z.boolean(),
});

export const refreshComputerTerminalSubscriptionInputSchema = computerTerminalAttachScopeSchema;

export const sendComputerTerminalInputSchema = computerTerminalAttachScopeSchema.extend({
  inputSeq: z.number().int().min(1).max(0xffff_ffff),
  dataBase64: z.string().min(1).max(24_576),
});

export const resizeComputerTerminalInputSchema = computerTerminalAttachScopeSchema.extend({
  cols: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
  rows: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
});

export const detachComputerTerminalInputSchema = computerTerminalAttachScopeSchema;

export const closeComputerTerminalInputSchema = computerIdInputSchema.extend({
  sessionId: z.string().regex(TERMINAL_ID_PATTERN).optional(),
  attachId: z.string().regex(TERMINAL_ID_PATTERN).optional(),
  attachGeneration: z.number().int().min(1).max(0xffff_ffff).optional(),
});
