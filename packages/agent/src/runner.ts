#!/usr/bin/env bun

import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashTool,
  defineTool,
  getAgentDir,
  ModelRuntime,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  agentApiRoutes,
  CHANNEL_ARGUMENT_EXAMPLES,
  decodeOpenVikingAgentCommand,
  decodeOpenVikingAgentResponse,
  formatOpenVikingMissingArgumentsError,
  isMemoryAgentToolProfile,
  listMissingOpenVikingFields,
  MEMORY_OFFER_BUDGET_PER_TRIGGER,
  MEMORY_READ_BUDGET_PER_TRIGGER,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  OPENVIKING_TOOL_NAMES,
  OPENVIKING_GRAPH_RELATIONS,
  toolsForMemoryFence,
  type MemoryAgentToolProfile,
  type OpenVikingAgentCommand,
  type OpenVikingAgentOperation,
} from "@lrm/coforge-sdk/agent";
import type { AgentConversationScope } from "./contract";
import { Type } from "typebox";
import { join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  getCoforgeAgentDir,
  getCoforgeSessionDir,
  PI_SESSION_DIR,
  prepareAgentSessionDirectory,
} from "./paths";
import { API_KEY_ENV_BY_PROVIDER, configureRuntimeEnvironment } from "./runtime-provider";
import { classifyPiLaunchFailure, PI_MODEL_UNAVAILABLE } from "./launch-error";

import { createMemoryDispositionTool } from "./memory-disposition-tool";

const MEMORY_READ_OPS = new Set(["find", "search_context", "read", "expand"]);

export type MemoryAgentProxy = {
  post(path: string, body: unknown): Promise<unknown>;
};

/** Per-triggering-message budget for the Memory Agent fence. */
export class MemoryAgentTurnBudget {
  #reads = 0;
  #offers = 0;

  reset(): void {
    this.#reads = 0;
    this.#offers = 0;
  }

  consume(command: OpenVikingAgentCommand): void {
    if (MEMORY_READ_OPS.has(command.op)) {
      if (this.#reads >= MEMORY_READ_BUDGET_PER_TRIGGER)
        throw new Error("memory read budget exhausted for this triggering message");
      const limit = "limit" in command ? command.limit : undefined;
      if (limit !== undefined && limit > OPENVIKING_CANDIDATE_LIMIT_MAX)
        throw new Error("candidate limit exceeded");
      this.#reads += 1;
      return;
    }
    if (command.op === "offer") {
      if (this.#offers >= MEMORY_OFFER_BUDGET_PER_TRIGGER)
        throw new Error("memory offer budget exhausted for this triggering message");
      this.#offers += 1;
    }
  }

  snapshot() {
    return {
      reads: this.#reads,
      offers: this.#offers,
    };
  }
}

type ProxyToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
};

function localProxyUrl(path: string, env?: Readonly<Record<string, string | undefined>>): string {
  const endpoint = env?.COFORGE_AGENT_PROXY_URL ?? Bun.env.COFORGE_AGENT_PROXY_URL;
  const token = env?.COFORGE_AGENT_CONTEXT ?? Bun.env.COFORGE_AGENT_CONTEXT;
  if (!endpoint || !token) throw new Error("CoForge Agent proxy is not configured");
  return new URL(path, endpoint).toString();
}

function proxyContextToken(env?: Readonly<Record<string, string | undefined>>): string {
  const token = env?.COFORGE_AGENT_CONTEXT ?? Bun.env.COFORGE_AGENT_CONTEXT;
  if (!token) throw new Error("CoForge Agent proxy is not configured");
  return token;
}

async function postLocalProxy(
  path: string,
  body: unknown,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const response = await fetch(localProxyUrl(path, env), {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxyContextToken(env)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(proxyFailureText(payload, response.status));
  return payload;
}

function proxyFailureText(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return `CoForge Agent proxy request failed (${status})`;
  const error = payload.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const message = typeof record.message === "string" ? record.message : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  return `CoForge Agent proxy request failed (${status})`;
}

function toolResult(value: unknown): ProxyToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
}

function defaultMemoryProxy(env?: Readonly<Record<string, string | undefined>>): MemoryAgentProxy {
  // The session environment, not the process env: Pi sessions run in the
  // Daemon process, so a second Agent's launch would otherwise overwrite
  // Bun.env.COFORGE_AGENT_CONTEXT and route this Agent's proxy calls — and
  // its fence binding — to the other Agent.
  return { post: (path, body) => postLocalProxy(path, body, env) };
}

/**
 * Models pass numeric tool arguments as strings often enough that the
 * resulting server-side decode failure burned the turn's read budget before
 * any real call went out. Coerce the numeric fence-tool parameters before the
 * command is built so a well-formed intent is never lost to formatting.
 */
function coerceNumericToolParams<P extends Record<string, unknown>>(params: P): P {
  const coerced = { ...params };
  for (const key of ["limit", "tokenBudget"]) {
    const value = coerced[key];
    if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value))) {
      (coerced as Record<string, unknown>)[key] = Number(value);
    }
  }
  // A bare "viking://" root is the model's shorthand for "everywhere"; the
  // server schema requires a real target, so omit it rather than burn a read.
  if (typeof coerced.targetUri === "string" && /^viking:\/\/\s*$/.test(coerced.targetUri)) {
    delete (coerced as Record<string, unknown>).targetUri;
  }
  return coerced;
}

const FENCE_ARGUMENTS_SENTENCE = "所有参数必须放进 arguments JSON，不能空对象。";

function isEmptyToolArguments(args: unknown): boolean {
  if (args == null) return true;
  if (typeof args !== "object" || Array.isArray(args)) return true;
  return Object.keys(args).length === 0;
}

function formatChannelMissingArguments(
  toolName: string,
  missing: readonly string[],
  example: string,
): string {
  const alias =
    toolName === "send_channel_message" ? " The body field name is content, not message." : "";
  return `invalid ${toolName} arguments: missing ${missing.join(", ")}. Example: ${example}.${alias}`;
}

/**
 * Rejects an empty arguments object before schema validation and before
 * `decodeOpenVikingAgentCommand`, so the model gets a copyable example and
 * the read budget is never touched. `message` fills `content` only when
 * `content` is absent.
 */
function prepareFenceArguments(input: {
  args: unknown;
  emptyError?: string;
  aliasMessage?: boolean;
}): Record<string, unknown> {
  if (input.emptyError && isEmptyToolArguments(input.args)) throw new Error(input.emptyError);
  const record =
    input.args && typeof input.args === "object" && !Array.isArray(input.args)
      ? { ...(input.args as Record<string, unknown>) }
      : {};
  if (input.aliasMessage && record.content == null && typeof record.message === "string")
    record.content = record.message;
  if (input.aliasMessage) delete record.message;
  return coerceNumericToolParams(record);
}

function openVikingEmptyArgumentsError(op: OpenVikingAgentOperation): string {
  return formatOpenVikingMissingArgumentsError(
    op,
    listMissingOpenVikingFields({ protocol: OPENVIKING_AGENT_PROTOCOL, op }),
  );
}

function withFenceArgumentSentence(description: string): string {
  return `${description} ${FENCE_ARGUMENTS_SENTENCE}`;
}

/** The only model-callable tools available under a Memory Agent fence. */
export function createMemoryFenceTools(
  profile: MemoryAgentToolProfile,
  budget: MemoryAgentTurnBudget,
  proxy: MemoryAgentProxy = defaultMemoryProxy(),
  options: {
    memoryOfferOnly?: boolean;
    conversation?: AgentConversationScope;
    controlSession?: boolean;
  } = {},
) {
  if (options.controlSession) return [];
  const openvikingTool = <Params extends Record<string, unknown>>(
    name: string,
    label: string,
    description: string,
    op: OpenVikingAgentCommand["op"],
    parameters: Parameters<typeof Type.Object>[0],
  ) =>
    defineTool({
      name,
      label,
      description: withFenceArgumentSentence(description),
      parameters: Type.Object(parameters),
      prepareArguments: (args) =>
        prepareFenceArguments({
          args,
          emptyError: openVikingEmptyArgumentsError(op),
        }) as never,
      execute: async (_toolCallId, params, signal) => {
        signal?.throwIfAborted();
        // Decode throws before consume, so an empty or invalid ov_* call does not
        // spend the triggering message's read budget and never reaches OpenViking.
        const command = decodeOpenVikingAgentCommand({
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op,
          ...coerceNumericToolParams(params as Params),
        });
        budget.consume(command);
        let decoded = decodeOpenVikingAgentResponse(
          command.op,
          await proxy.post(agentApiRoutes.proxy.openviking.path, command),
        );
        // Poll inside the native tool, avoiding a model turn for every status check.
        for (
          let poll = 0;
          poll < 10 && decoded.op === "diagnose" && decoded.status === "running";
          poll++
        ) {
          await Bun.sleep(5000);
          signal?.throwIfAborted();
          decoded = decodeOpenVikingAgentResponse(
            command.op,
            await proxy.post(agentApiRoutes.proxy.openviking.path, command),
          );
        }
        return toolResult(decoded);
      },
    });

  const messageTool = (
    name: string,
    label: string,
    description: string,
    operation: "check" | "read" | "send",
    parameters: Parameters<typeof Type.Object>[0],
  ) =>
    defineTool({
      name,
      label,
      description: name === "message_check" ? description : withFenceArgumentSentence(description),
      parameters: Type.Object(parameters),
      prepareArguments: (args) =>
        prepareFenceArguments({
          args,
          emptyError:
            name === "message_read"
              ? formatChannelMissingArguments(
                  name,
                  ["target"],
                  CHANNEL_ARGUMENT_EXAMPLES.message_read,
                )
              : name === "send_channel_message"
                ? formatChannelMissingArguments(
                    name,
                    ["target", "content"],
                    CHANNEL_ARGUMENT_EXAMPLES.send_channel_message,
                  )
                : undefined,
          aliasMessage: name === "send_channel_message",
        }) as never,
      execute: async (_toolCallId, params) => {
        // The post-merge message contract keys a request by `idempotencyKey`
        // (`requestId` is not read anywhere: daemon parseMessageRequest and the web
        // send route both reject its absence as 400). Some models pass the schema's
        // Integer `limit` as a numeric string; the daemon only accepts a number.
        // `message` is an alias of `content` only when content was omitted.
        const raw = { ...(params as Record<string, unknown>) };
        if (options.conversation) {
          const parent = options.conversation.target.split(":")[0]!;
          raw.target ??= parent;
          if (typeof raw.target !== "string" || raw.target.split(":")[0] !== parent)
            throw new Error("Memory messages must stay within this conversation");
        }
        if (operation === "send" && raw.content == null && typeof raw.message === "string")
          raw.content = raw.message;
        if (operation === "send") delete raw.message;
        const request: Record<string, unknown> = {
          idempotencyKey: crypto.randomUUID(),
          operation,
          ...raw,
        };
        if (typeof request.limit === "string" && /^\d+$/.test(request.limit))
          request.limit = Number(request.limit);
        if (
          operation === "send" &&
          typeof request.target === "string" &&
          !request.target.startsWith("#")
        )
          throw new Error("send_channel_message only sends to a public channel");
        return toolResult(await proxy.post(agentApiRoutes.proxy.messages.path, request));
      },
    });

  const openvikingByName: Record<string, ReturnType<typeof defineTool>> = {
    [OPENVIKING_TOOL_NAMES.diagnose]: openvikingTool(
      OPENVIKING_TOOL_NAMES.diagnose,
      "Diagnose with four roles",
      "Start or poll four-role AIG diagnosis for a task agent message containing @memory diagnose. Read messages to get messageId. The server binds evidence and recipient and publishes the approved report. Repeat the same messageId while running; stop after published=true or failed. This never dispatches remediation.",
      "diagnose",
      {
        operationId: Type.String(),
        messageId: Type.String({
          description:
            "Full UUID of the task agent’s saved @memory diagnose message, obtained with message_read.",
        }),
      },
    ),
    [OPENVIKING_TOOL_NAMES.expand]: openvikingTool(
      OPENVIKING_TOOL_NAMES.expand,
      "Expand memory graph",
      "Follow an explicit relation from a Fork or AIG node already returned by ov_find or ov_expand. Reuse retrieval.chainRef and choose a node URI and one of its listed relations. Expansion is bounded and uses no embedding.",
      "expand",
      {
        operationId: Type.String(),
        chainRef: Type.String(),
        uri: Type.String(),
        relation: Type.Union(OPENVIKING_GRAPH_RELATIONS.map((value) => Type.Literal(value))),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      },
    ),
    [OPENVIKING_TOOL_NAMES.find]: openvikingTool(
      OPENVIKING_TOOL_NAMES.find,
      "OpenViking find",
      "Use BM25 only to find cited documents, experiences, Fork nodes, and AIG nodes for the current question. No embedding or vector fallback is used.",
      "find",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: find-1. Use a new id on every call.",
        }),
        query: Type.String({
          description: "Required. Search text. Example: deploy rollback.",
        }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Optional. Integer from 1 to 10. Example: 10.",
          }),
        ),
        targetUri: Type.Optional(
          Type.String({
            description:
              "Optional. URI scope. Omit to search the whole workspace. Example: viking://workspace/docs.",
          }),
        ),
      },
    ),
    [OPENVIKING_TOOL_NAMES.read]: openvikingTool(
      OPENVIKING_TOOL_NAMES.read,
      "OpenViking read",
      "Read one cited OpenViking document by URI.",
      "read",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: read-1. Use a new id on every call.",
        }),
        uri: Type.String({
          description:
            "Required. Document URI returned by ov_find. Example: viking://workspace/docs/note.md.",
        }),
      },
    ),
    [OPENVIKING_TOOL_NAMES.offer]: openvikingTool(
      OPENVIKING_TOOL_NAMES.offer,
      "Publish Memory Offer",
      "Publish one visible, cited Memory Offer. This is the only visible answer to an explicit @memory question. citationRefs are citation ids already returned in this workspace. The server binds the channel and recipient.",
      "offer",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: offer-1. Use a new id on every call.",
        }),
        citationRefs: Type.Array(
          Type.String({
            description: "One citation id already returned in this workspace.",
          }),
          {
            minItems: 1,
            description:
              'Required. Array of at least 1 citation id already returned in this workspace. Example: ["ov:wiki/deploy"].',
          },
        ),
        body: Type.String({
          description:
            "Required. Offer text for the task agent. Example: the last deploy rolled back.",
        }),
      },
    ),
  };

  const fenced = toolsForMemoryFence(profile).map((name) => {
    const tool = openvikingByName[name];
    if (!tool) throw new Error(`unsupported Memory Agent tool: ${name}`);
    return tool;
  });

  return [
    ...fenced,
    messageTool(
      "message_check",
      "Check messages",
      "Check pending CoForge messages without shell or network access.",
      "check",
      {
        target: Type.Optional(
          Type.String({
            description: "Optional. Exact target from this conversation or its threads.",
          }),
        ),
      },
    ),
    messageTool(
      "message_read",
      "Read messages",
      "Read public-channel messages through the CoForge message route.",
      "read",
      {
        target: Type.String({
          description: "Required. Public channel target. Example: #general.",
        }),
        before: Type.Optional(
          Type.String({ description: "Optional. Read messages before this message id." }),
        ),
        after: Type.Optional(
          Type.String({ description: "Optional. Read messages after this message id." }),
        ),
        around: Type.Optional(
          Type.String({ description: "Optional. Read messages around this message id." }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Optional. Integer from 1 to 100. Example: 20.",
          }),
        ),
      },
    ),
    ...(options.memoryOfferOnly
      ? []
      : [
          messageTool(
            "send_channel_message",
            "Send channel message",
            "Send a visible public-channel message through CoForge. This cannot answer an explicit @memory question; use memory_offer. The body field name is content, not message.",
            "send",
            {
              target: Type.String({
                description: "Required. Public channel target starting with #. Example: #general.",
              }),
              content: Type.String({
                description:
                  "Required. Message body. The field name is content, not message. Example: the deploy rolled back.",
              }),
            },
          ),
        ]),
  ];
}

/** The only model-callable tools available under the openviking-memory fence. */
export function createOpenVikingMemoryTools(
  budget: MemoryAgentTurnBudget,
  proxy?: MemoryAgentProxy,
) {
  return createMemoryFenceTools("openviking-memory", budget, proxy);
}

export const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
}) => {
  const instructions = Bun.env.COFORGE_AGENT_INSTRUCTIONS;
  if (!instructions?.trim()) throw new Error("CoForge Agent instructions are required");
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: { systemPromptOverride: () => instructions },
  });
  const skillDiagnostics = services.resourceLoader.getSkills().diagnostics;
  if (skillDiagnostics.length > 0) {
    throw new Error(`Cannot start with ${skillDiagnostics.length} skill diagnostic(s)`);
  }
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

export const EVAL_DISABLE_HOST_PI_INJECTION = "COFORGE_EVAL_DISABLE_HOST_PI_INJECTION";

export function evalDisablesHostPiInjection(
  env: { [key: string]: string | undefined } = Bun.env,
): boolean {
  const value = env[EVAL_DISABLE_HOST_PI_INJECTION];
  return value === "1" || value === "true";
}

/** Memory Agent and public-channel eval sessions must not ingest Pi host skills,
 * context files, or extensions. Team memory and skills come from the Memory Agent. */
export function resourceLoaderOptionsForSession(input: {
  instructions: string;
  memoryFence?: boolean;
  disableHostPiInjection?: boolean;
}) {
  const isolate = Boolean(input.memoryFence || input.disableHostPiInjection);
  return {
    systemPromptOverride: () => input.instructions,
    ...(isolate ? { noSkills: true, noContextFiles: true, noExtensions: true } : {}),
  };
}

export async function createSession(options: {
  cwd: string;
  agentId?: string;
  agentDir?: string;
  sessionDir?: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  modelProvider?: string;
  model?: string;
  reasoning?: string;
  apiKey?: string;
  instructions: string;
  environment?: Readonly<Record<string, string>>;
  sessionKind?: "coforge" | "pi";
  conversation?: AgentConversationScope;
  memoryControlSession?: boolean;
  toolProfile?: MemoryAgentToolProfile;
  /** Eval-only Offer contract; ordinary product sessions retain channel send. */
  memoryOfferOnly?: boolean;
}) {
  const cwd = options.cwd;
  const environment = options.environment
    ? { ...options.environment }
    : Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => !!entry[1]),
      );
  const agentDir = options.agentDir ?? getCoforgeAgentDir(cwd);
  const sessionDir = options.sessionDir ?? getCoforgeSessionDir(cwd);
  const sessionKind = options.sessionKind ?? "coforge";
  const expectedSessionDir = join(
    cwd,
    sessionKind === "coforge" ? ".builtin-sessions" : PI_SESSION_DIR,
  );
  if (resolve(sessionDir) !== resolve(expectedSessionDir))
    throw new Error(
      `${sessionKind === "coforge" ? "CoForge" : "Pi"} sessions must use ${sessionKind === "coforge" ? ".builtin-sessions" : PI_SESSION_DIR}`,
    );
  if (sessionKind === "coforge" && !options.apiKey)
    throw new Error("CoForge runtime provider API key is required");
  const { sessionManager, replacedSessionId } = await sessionManagerFor(
    cwd,
    sessionDir,
    options.sessionId ?? options.agentId,
    options.sessionMode ?? (options.sessionId ? "resume" : "create"),
  );
  const modelRuntime =
    sessionKind === "pi"
      ? await createPiModelRuntime(agentDir, environment ?? {})
      : await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
        });
  if (options.modelProvider && options.apiKey)
    await modelRuntime.setRuntimeApiKey(options.modelProvider, options.apiKey);
  configureRuntimeEnvironment(modelRuntime, environment);
  if (sessionKind === "pi") {
    try {
      await refreshPiModelCatalog(
        modelRuntime,
        environment,
        options.modelProvider ? [options.modelProvider] : undefined,
      );
    } catch (refreshError) {
      // A timed-out/network-failed provider refresh must not surface as an opaque SDK
      // TimeoutError (the old error_code "23"): classify it with launch trace evidence.
      throw classifyPiLaunchFailure(
        modelRuntime,
        options.modelProvider,
        options.model,
        refreshError,
      );
    }
  }
  const memoryFence = isMemoryAgentToolProfile(options.toolProfile)
    ? options.toolProfile
    : undefined;
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: resourceLoaderOptionsForSession({
      instructions: options.instructions,
      memoryFence: Boolean(memoryFence) || Boolean(options.memoryControlSession),
      disableHostPiInjection:
        evalDisablesHostPiInjection(options.environment) || evalDisablesHostPiInjection(),
    }),
  });
  if (sessionKind === "coforge") {
    const skillDiagnostics = services.resourceLoader.getSkills().diagnostics;
    if (skillDiagnostics.length > 0)
      throw new Error(`Cannot start with ${skillDiagnostics.length} skill diagnostic(s)`);
  }
  const model =
    options.modelProvider && options.model
      ? modelRuntime.getModel(options.modelProvider, options.model)
      : undefined;
  if (options.model && !model)
    throw classifyPiLaunchFailure(
      modelRuntime,
      options.modelProvider,
      options.model,
      PI_MODEL_UNAVAILABLE,
    );
  const extensionDefinesBash = services.resourceLoader
    .getExtensions()
    .extensions.some((extension) => extension.tools.has("bash"));
  const memoryBudget = memoryFence ? new MemoryAgentTurnBudget() : undefined;
  const memoryTools =
    memoryFence && memoryBudget
      ? createMemoryFenceTools(memoryFence, memoryBudget, defaultMemoryProxy(environment), {
          memoryOfferOnly: options.memoryOfferOnly,
          conversation: options.conversation,
          controlSession: options.memoryControlSession,
        })
      : [];
  const customTools = [
    ...(options.environment &&
    !extensionDefinesBash &&
    !memoryBudget &&
    !options.memoryControlSession
      ? [
          createBashTool(cwd, {
            shellPath: services.settingsManager.getShellPath(),
            commandPrefix: services.settingsManager.getShellCommandPrefix(),
            spawnHook: ({ env, ...context }) => {
              const childEnv = { ...env };
              for (const key of [
                "COFORGE_AGENT_CONTEXT",
                "COFORGE_AGENT_CONVERSATION_TARGET",
                "COFORGE_AGENT_PROXY_URL",
                "COFORGE_DAEMON_SOCKET",
                "COFORGE_SUPERVISOR_SOCKET",
                "COFORGE_CURRENT_AGENT_ID",
                "COFORGE_CURRENT_AGENT_NAME",
                "COFORGE_CURRENT_WORKSPACE_ID",
                "COFORGE_CURRENT_WORKSPACE_SLUG",
                "COFORGE_CURRENT_WORKSPACE_NAME",
                "COFORGE_CURRENT_COMPUTER_ID",
                "COFORGE_CURRENT_COMPUTER_NAME",
                "COFORGE_CURRENT_COMPUTER_HOSTNAME",
                "COFORGE_CURRENT_COMPUTER_OS",
                "COFORGE_CURRENT_COMPUTER_VERSION",
                "COFORGE_CURRENT_AGENT_WORKSPACE_PATH",
              ])
                delete childEnv[key];
              Object.assign(childEnv, environment);
              // Pi resolves current metadata before the hook, including absent values.
              for (const key of [
                "PI_SESSION_ID",
                "PI_SESSION_FILE",
                "PI_PROVIDER",
                "PI_MODEL",
                "PI_REASONING_LEVEL",
              ]) {
                if (env[key] === undefined) delete childEnv[key];
                else childEnv[key] = env[key];
              }
              return { ...context, env: childEnv };
            },
          }),
        ]
      : []),
    ...memoryTools,
    ...(!memoryFence ? [createMemoryDispositionTool(defaultMemoryProxy(environment))] : []),
  ];
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model ? { model } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning as never } : {}),
    ...(memoryBudget || options.memoryControlSession
      ? {
          noTools: "all" as const,
          tools: memoryTools.map((tool) => tool.name),
          customTools: memoryTools,
        }
      : customTools.length > 0
        ? { customTools }
        : {}),
  });
  return {
    ...created,
    services,
    replacedSessionId,
    resetMemoryBudget: memoryBudget ? () => memoryBudget.reset() : undefined,
    get sessionId() {
      return sessionManager.getSessionId();
    },
    dispose: async () => {
      created.session.clearQueue();
      await created.session.abort();
      await created.session.waitForIdle();
      created.session.dispose();
    },
  };
}

async function sessionManagerFor(
  cwd: string,
  sessionDir: string,
  sessionId: string | undefined,
  mode: "create" | "resume",
) {
  const workspace = await prepareAgentSessionDirectory(cwd, sessionDir);
  if (sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId))
    throw new Error("Invalid session ID");
  if (sessionId) {
    const path = await findSessionFileForWorkspace(workspace, sessionDir, sessionId);
    if (path) {
      const sessionManager = SessionManager.open(path, sessionDir, workspace);
      if (sessionManager.getSessionId() !== sessionId)
        throw new Error("CoForge session history changed during recovery");
      return { sessionManager, replacedSessionId: undefined };
    }
  }
  const replacedSessionId = mode === "resume" ? sessionId : undefined;
  return {
    sessionManager: SessionManager.create(workspace, sessionDir, {
      id: replacedSessionId ? crypto.randomUUID() : sessionId,
    }),
    replacedSessionId,
  };
}

/** Scoped Pi-format lookup that preserves I/O and malformed-header failures. */
export async function findSessionFile(
  sessionDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const workspace = await prepareAgentSessionDirectory(resolve(sessionDir, ".."), sessionDir);
  return findSessionFileForWorkspace(workspace, sessionDir, sessionId);
}

async function findSessionFileForWorkspace(
  workspace: string,
  sessionDir: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId))
    throw new Error("Invalid session ID");
  // SDK list() hides read failures. Inspect scoped headers directly, including
  // renamed files, so a missing filename is not mistaken for missing history.
  const files = await readdir(sessionDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  let match: string | undefined;
  for (const name of files.filter((name) => name.endsWith(".jsonl"))) {
    const path = join(sessionDir, name);
    const content = await readFile(path, "utf8");
    const header = JSON.parse(content.split("\n").find((line) => line.trim()) ?? "null");
    if (header?.type !== "session" || typeof header.id !== "string")
      throw new Error("Invalid CoForge session history");
    if (header.cwd !== workspace) continue;
    if (header.id !== sessionId) continue;
    if (match) throw new Error("Ambiguous CoForge session history");
    match = path;
  }
  return match;
}

/** Resolve Pi's exact persisted identity without its CLI prefix/global fallback. */
export async function resolveAgentSessionFile(cwd: string, sessionDir: string, sessionId: string) {
  const workspace = await prepareAgentSessionDirectory(cwd, sessionDir);
  const existing = await findSessionFileForWorkspace(workspace, sessionDir, sessionId);
  if (!existing) throw new Error("Session not found in Agent workspace");
  return existing;
}

export async function discoverModels(cwd: string) {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getCoforgeAgentDir(cwd),
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
}

export async function discoverPiModels(
  cwd: string,
  options: { agentDir: string; environment?: Readonly<Record<string, string>>; force?: boolean },
) {
  const environment = { ...options.environment };
  const modelRuntime = await createPiModelRuntime(options.agentDir, environment);
  configureRuntimeEnvironment(modelRuntime, environment);
  await refreshPiModelCatalog(modelRuntime, environment, undefined, options.force);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: options.agentDir,
    modelRuntime,
    resourceLoaderOptions: { systemPromptOverride: () => "" },
  });
  return services.modelRuntime.getAvailableSnapshot();
}

async function createPiModelRuntime(
  agentDir: string,
  environment: Readonly<Record<string, string>> = {},
) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // Resolve native environment credentials through Pi so stored auth retains
  // priority. Snapshot single-key auth per session, without patching process.env.
  // OAuth remains SDK-owned so token refresh is not replaced by a static key.
  for (const [provider, variable] of Object.entries(API_KEY_ENV_BY_PROVIDER)) {
    if (!environment[variable] || modelRuntime.isUsingOAuth(provider)) continue;
    const resolved = await modelRuntime.getAuth(provider, { env: { ...environment } });
    if (resolved?.auth.apiKey) await modelRuntime.setRuntimeApiKey(provider, resolved.auth.apiKey);
  }
  return modelRuntime;
}

/** How long a Pi model catalog network refresh may run before it is aborted. */
export const PI_MODEL_REFRESH_TIMEOUT_MS = 5_000;

async function refreshPiModelCatalog(
  modelRuntime: ModelRuntime,
  environment: Readonly<Record<string, string>>,
  providers?: readonly string[],
  force = false,
) {
  if (Bun.env.PI_OFFLINE !== undefined || environment.PI_OFFLINE !== undefined) {
    if (force) throw new Error("Pi model catalog refresh is unavailable in offline mode");
    return;
  }
  const configuredProviders =
    providers?.filter((provider) => modelRuntime.hasConfiguredAuth(provider)) ??
    modelRuntime
      .getProviders()
      .flatMap((provider) => (modelRuntime.hasConfiguredAuth(provider.id) ? [provider.id] : []));
  if (configuredProviders.length === 0) return;
  // Launches are best-effort and unforced. Without `force`, the SDK's own interval decides when the
  // network is worth hitting, so a slow, offline or hanging network can no longer make every Pi
  // launch wait on (or fail through) a forced catalog fetch. The models already on disk stay
  // usable; a genuinely missing model still fails later, deterministically, at model resolution.
  // Live directory discovery forces a probe and reports failure rather than calling old data fresh.
  try {
    const refreshed = await modelRuntime.refresh({
      providers: configuredProviders,
      allowNetwork: true,
      force,
      signal: AbortSignal.timeout(PI_MODEL_REFRESH_TIMEOUT_MS),
    });
    if (force && (refreshed.aborted || refreshed.errors.size > 0))
      throw new Error("Pi model catalog refresh failed");
  } catch (error) {
    if (force) throw error;
    // A catalog refresh must never fail the launch.
  }
}

if (import.meta.main) {
  const cwd = process.cwd();
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.inMemory(cwd),
  });
  await runRpcMode(runtime);
}
