import { z } from "zod";
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_PATTERN,
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  RUNTIME_PROVIDER_VALUES,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { runtimeProviderSelectionRefusal } from "./runtime-provider-selection";
import { AGENT_VISIBILITY, AGENT_VISIBILITY_VALUES } from "./agent-visibility";

/** The Agent self-description cap, shared by the edit-form schema and the server's
 * self-service profile check so the two never disagree. */
export const AGENT_PROFILE_DESCRIPTION_MAX_LENGTH = 500;

export const KEYED_MODEL_PROVIDERS = new Set([
  "deepseek",
  "minimax",
  "minimax-cn",
  "zai",
  "zai-coding-cn",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "xai",
  "xiaomi",
]);

/** The Pi runtime's own built-in providers, offered directly in the Pi "Provider" picker
 * alongside "Configured" (the Computer's own `~/.pi/agent` setup). A narrower set than
 * `KEYED_MODEL_PROVIDERS` (CoForge's full keyed-provider catalog): Pi only ever launches with an
 * Agent-entered key for one of these two. */
export const PI_BUILTIN_MODEL_PROVIDERS = ["deepseek", "openrouter"] as const;
const PI_BUILTIN_MODEL_PROVIDER_SET: ReadonlySet<string> = new Set(PI_BUILTIN_MODEL_PROVIDERS);
export function isPiBuiltinModelProvider(value: string): boolean {
  return PI_BUILTIN_MODEL_PROVIDER_SET.has(value);
}

const apiKeySchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(8).max(4096).optional(),
);

// The @mention username: fixed at creation, never renamed afterward. The bound and its grammar are
// the SDK's one definition (`@lrm/coforge-sdk/internal`, where the sender-handle bound reads the
// same value); re-exported here because the web modules that build a freed name from it import it
// from this file.
export { AGENT_NAME_MAX_LENGTH };

const nameSchema = z.string().trim().min(1).max(AGENT_NAME_MAX_LENGTH).regex(AGENT_NAME_PATTERN);

export const AGENT_DISPLAY_NAME_MAX_LENGTH = 80;

export const createCloudAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(AGENT_DISPLAY_NAME_MAX_LENGTH),
  requestId: z.uuid(),
});

// Free-text label, independent of `name`; any charset. Editable only after creation, where it
// defaults to the username.
const displayNameSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(AGENT_DISPLAY_NAME_MAX_LENGTH).optional(),
);

const agentInputShape = {
  description: z.string().trim().max(AGENT_PROFILE_DESCRIPTION_MAX_LENGTH).default(""),
  provider: z.enum(RUNTIME_PROVIDER_VALUES).superRefine((provider, context) => {
    const refusal = runtimeProviderSelectionRefusal(provider);
    if (refusal) context.addIssue({ code: "custom", message: refusal });
  }),
  model: z.string().trim().max(200).optional(),
  modelProvider: z.string().trim().max(100).optional(),
  reasoning: z.string().trim().max(50).optional(),
  /** Whether the Agent launches with the runtime's Fast service tier. The server re-checks the
   * provider and the model's reported capability; this only carries the intent. Optional so a
   * client that predates it keeps parsing, and absent means the ordinary tier. */
  fastMode: z.boolean().optional(),
  apiKey: apiKeySchema,
};

function validateRuntimeKey(
  value: { provider: RuntimeProvider; modelProvider?: string; apiKey?: string },
  context: z.RefinementCtx,
) {
  if (!value.apiKey) return;
  if (RUNTIME_PROVIDER_USES_EXTERNAL_CLI[value.provider]) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "Unsupported runtime key" });
  }
  if (!value.modelProvider) {
    context.addIssue({ code: "custom", path: ["modelProvider"], message: "Required for API key" });
  }
  if (
    value.provider === RUNTIME_PROVIDER.PI &&
    !isPiBuiltinModelProvider(value.modelProvider ?? "")
  ) {
    context.addIssue({
      code: "custom",
      path: ["modelProvider"],
      message: "Unsupported Pi API key provider",
    });
  }
}

export const createAgentInputSchema = z
  .object({
    ...agentInputShape,
    name: nameSchema,
    computerId: z.string().min(1),
    /** Present when this create submits an Agent-prepared `agent:create` action card;
     * marks the card `executed` after the Agent is created. */
    actionCardMessageId: z.uuid().optional(),
    /** Who can see this new Agent; defaults to public, matching every creation path
     * except the weekly-report Collector Agent, which is created private outside this schema. */
    visibility: z.enum(AGENT_VISIBILITY_VALUES).default(AGENT_VISIBILITY.PUBLIC),
  })
  .superRefine(validateRuntimeKey);

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentInputSchema = z
  .object({
    ...agentInputShape,
    displayName: displayNameSchema,
    agentId: z.uuid(),
    computerId: z.string().min(1).optional(),
  })
  .superRefine(validateRuntimeKey);
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

export const agentIdSchema = z.uuid();
/** The per-Agent realtime subscription token endpoints; any Server Function that only
 * needs an authorized Agent id shares this shape rather than repeating the object literal. */
export const agentIdInputSchema = z.object({ agentId: agentIdSchema });
/** The extras read's input: the Agents whose display it must answer beyond the busy ones. Bounded
 * only against abuse; the read itself dedupes and keeps the first `HELD_AGENT_IDS_LIMIT`. */
export const loadExtraAgentsInputSchema = z.object({
  heldAgentIds: z.array(agentIdSchema).max(5_000),
});
/** Deleting an Agent is name-confirmed, the same guard `ProjectSettings.delete` uses —
 * the server re-checks the typed name against the current row in the delete itself, so a
 * concurrent rename cannot bypass confirmation. */
export const deleteAgentInputSchema = z.object({
  agentId: agentIdSchema,
  confirmation: z.string().trim().min(1).max(64),
});
export const updateAgentRoleInputSchema = z.object({
  agentId: agentIdSchema,
  role: z.enum(["admin", "member"]),
});

/** Changes an Agent's visibility, both directions. `changeAgentVisibility` is the only
 * server function that writes this field; `createAgentInputSchema.visibility` is create-time only. */
export const changeAgentVisibilityInputSchema = z.object({
  agentId: agentIdSchema,
  visibility: z.enum(AGENT_VISIBILITY_VALUES),
});
export const saveAgentRuntimeCredentialInputSchema = z.object({
  agentId: agentIdSchema,
  apiKey: z.string().trim().min(8).max(4096),
});

export const saveAgentEnvironmentInputSchema = z.object({
  agentId: agentIdSchema,
  envVars: z.record(z.string(), z.string()),
});

// A thin gate ahead of the codec's own strict validation (`agent-workspace-files.ts` rejects
// control bytes, `..` segments, absolute/Windows paths, etc. on encode) — this just rejects
// wildly wrong types/sizes before that.
export const listAgentWorkspaceFilesInputSchema = z.object({
  agentId: agentIdSchema,
  dirPath: z.string().max(4096).default(""),
  includeHidden: z.boolean().default(false),
});

export const readAgentWorkspaceFileInputSchema = z.object({
  agentId: agentIdSchema,
  path: z.string().min(1).max(4096),
});
