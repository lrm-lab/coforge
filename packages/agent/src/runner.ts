import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  getCoforgeAgentDir,
  getCoforgeSessionDir,
  PI_SESSION_DIR,
  prepareAgentSessionDirectory,
} from "./paths";
import { configureRuntimeEnvironment } from "./runtime-provider";
import { createPiModelRuntime, refreshPiModelCatalog } from "./pi-model-catalog";
import { classifyPiLaunchFailure, PI_MODEL_UNAVAILABLE } from "./launch-error";
import {
  evalDisablesHostPiInjection,
  resourceLoaderOptionsForSession,
} from "./session-resource-loader";
export {
  EVAL_DISABLE_HOST_PI_INJECTION,
  evalDisablesHostPiInjection,
  resourceLoaderOptionsForSession,
} from "./session-resource-loader";
import { installChannelTurnPolicy } from "./channel-turn-policy";
import { modelWithSizes } from "./model-size-override";
import { contextViewRequestLogFields } from "./session-context-view-log";
import type { CreateSessionOptions } from "./session-options";
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
export async function createSession(options: CreateSessionOptions) {
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
      throw classifyPiLaunchFailure(
        modelRuntime,
        options.modelProvider,
        options.model,
        refreshError,
      );
    }
  }
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: resourceLoaderOptionsForSession({
      instructions: options.instructions,
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
  const launchModel = model && modelWithSizes(model, options);
  const extensionDefinesBash = services.resourceLoader
    .getExtensions()
    .extensions.some((extension) => extension.tools.has("bash"));
  const customTools = [
    ...(options.environment && !extensionDefinesBash
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
  ];
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(launchModel ? { model: launchModel } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning as never } : {}),
    ...(customTools.length > 0 ? { customTools } : {}),
  });
  const removeChannelTurnPolicy = installChannelTurnPolicy(created.session, {
    settleMessageSends:
      (environment.COFORGE_EVAL_SETTLE_SENDS ?? Bun.env.COFORGE_EVAL_SETTLE_SENDS) === "1",
  });
  return {
    ...created,
    services,
    replacedSessionId,
    get sessionId() {
      return sessionManager.getSessionId();
    },
    ...contextViewRequestLogFields(
      sessionDir,
      options.contextViewRequestLogDirectory,
      sessionManager.getSessionId(),
    ),
    dispose: async () => {
      removeChannelTurnPolicy();
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
export async function resolveAgentSessionFile(cwd: string, sessionDir: string, sessionId: string) {
  const workspace = await prepareAgentSessionDirectory(cwd, sessionDir);
  const existing = await findSessionFileForWorkspace(workspace, sessionDir, sessionId);
  if (!existing) throw new Error("Session not found in Agent workspace");
  return existing;
}
