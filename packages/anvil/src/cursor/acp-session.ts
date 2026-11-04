import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile, AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import { RuntimeModelNotFoundError } from "#src/contract";
import type { CursorAcpRuntimeHost } from "./acp-host";
import { CursorAcpTurnEvents } from "./acp-update-events";
import { isOldCursorModelId, resolveCursorCompositeId } from "./model-variants";
import type { CursorInstructions } from "./instructions";

/** How long a production session waits for each bounded ACP answer. */
export const CURSOR_ACP_TIMEOUT_MS = 120_000;

/** How many trailing stderr lines reach the host when the process closes. */
const STDERR_TAIL_LINES = 40;

/** `session/load` answers `-32602 Invalid params` with `Session "…" not found` in
 * `data.message` when the stored session is gone — a missing native session is replaced with a
 * fresh one and reported; any other failure surfaces. Verified on cursor-agent 2026.10.22. */
const CURSOR_SESSION_MISSING_CODE = -32602;

/** Whether the server advertises `loadSession` — the resume this launch contract needs. */
export function cursorLoadSessionDeclared(response: InitializeResponse): boolean {
  return response.agentCapabilities?.loadSession === true;
}

export class CursorUnsupportedOptionError extends Error {
  constructor(option: string) {
    super(`cursor-agent acp does not support required option ${option}`);
    this.name = "CursorUnsupportedOptionError";
  }
}

export const CURSOR_ACP_PROFILE: AcpRuntimeProfile = {
  args: ["acp"],
  capabilityCheck: (response) => {
    if (!cursorLoadSessionDeclared(response)) throw new CursorUnsupportedOptionError("loadSession");
  },
  messages: {
    unsupportedProtocol: "cursor-agent acp does not speak the ACP version this session requires",
    closedBeforeConfig: "cursor-agent acp closed before the session configured",
    timedOut: "cursor-agent acp did not answer in time",
  },
};

export async function createCursorAcpSession(
  options: AgentSessionOptions,
  command: readonly string[],
  host: CursorAcpRuntimeHost,
  instructions: CursorInstructions | undefined,
  acpTimeoutMs?: number,
): Promise<AgentSession> {
  const timeoutMs = acpTimeoutMs ?? CURSOR_ACP_TIMEOUT_MS;
  const profile = cursorSessionProfile(options, command, host, instructions, timeoutMs);
  const session = new AcpSession(profile, options, timeoutMs, (work) =>
    acpBounded(work, timeoutMs, CURSOR_ACP_PROFILE.messages.timedOut),
  );
  try {
    await session.open();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

function cursorSessionProfile(
  options: AgentSessionOptions,
  command: readonly string[],
  host: CursorAcpRuntimeHost,
  instructions: CursorInstructions | undefined,
  timeoutMs: number,
): AcpSessionProfile {
  return {
    label: "Cursor",
    openTransport: (sink) => {
      const stderrTail: string[] = [];
      const transport = acpProcess(CURSOR_ACP_PROFILE, {
        command,
        cwd: options.agentWorkspaceDirectory,
        environment: host.buildEnvironment(options),
        clientInfo: host.clientInfo,
        processTreeSpawner: host.processTreeSpawner,
        onUpdate: (method, params) => {
          if (method !== "session/update") return sink.notification(method, asRecord(params) ?? {});
          const sessionId = nonEmptyString(asRecord(params)?.sessionId);
          const update = asRecord(asRecord(params)?.update);
          if (sessionId && update) sink.update(sessionId, update);
        },
        onPermission: (request) => sink.permission(request),
        onPromptWrite: () => sink.promptWritten(),
        onStderr: (line) => {
          if (stderrTail.length === STDERR_TAIL_LINES) stderrTail.shift();
          stderrTail.push(line);
        },
      });
      transport.process.onClose(() => {
        if (stderrTail.length > 0) host.stderrHint?.(stderrTail);
      });
      return transport;
    },
    openSession: async (transport, sessionId) => {
      const agent = transport.connection.agent;
      const cwd = options.agentWorkspaceDirectory;
      const resuming = sessionId !== undefined && options.sessionMode !== "create";
      let opened: string | undefined;
      let replaced: string | undefined;
      let configOptions: unknown[] = [];
      let models: unknown[] = [];
      if (resuming) {
        try {
          const loaded = await acpBounded(
            agent.request("session/load", {
              sessionId,
              cwd,
              mcpServers: [],
            }),
            timeoutMs,
            "cursor-agent acp session/load timed out",
          );
          opened = sessionId;
          configOptions = readConfigOptions(loaded);
          models = readModels(loaded);
        } catch (error) {
          const missing =
            error instanceof RequestError &&
            error.code === CURSOR_SESSION_MISSING_CODE &&
            /session .{0,80}not found/i.test(
              nonEmptyString(asRecord(error.data)?.message) ?? error.message,
            );
          if (!missing) throw error;
          replaced = sessionId;
        }
      }
      if (!opened) {
        const state = await acpBounded(
          agent.request("session/new", { cwd, mcpServers: [] }),
          timeoutMs,
          "cursor-agent acp session/new timed out",
        );
        opened = nonEmptyString(asRecord(state)?.sessionId);
        if (!opened) throw new Error("cursor-agent acp did not create a session");
        configOptions = readConfigOptions(state);
        models = readModels(state);
      }
      await applyRuntimeConfig(
        transport,
        options,
        opened,
        configOptions as SessionConfigOption[],
        models,
        timeoutMs,
        host,
      );
      return { sessionId: opened, resumable: resuming && !replaced, replacedSessionId: replaced };
    },
    turn: () => new CursorAcpTurnEvents(host),
    // A prompt sent while a turn runs is this server's steer: the second `session/prompt`
    // resolves with its own stopReason when its turn ends, so the request cannot hold the ACP
    // deadline. A cancelled answer is a refused steer — the daemon redelivers once idle.
    steer: {
      unboundedRequest: true,
      request: (text, sessionId) => ({
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] },
      }),
      accepted: (response) => {
        // Any answered steer reached the model — `end_turn` ends the merged turn with the text
        // consumed. Only a cancellation or a refusal means the notice never landed, and an
        // answer without a stopReason is treated the same way rather than guessed delivered.
        const stopReason = nonEmptyString(asRecord(response)?.stopReason);
        return {
          accepted:
            stopReason !== undefined && stopReason !== "cancelled" && stopReason !== "refusal",
        };
      },
    },
    // `session/cancel` is `-32601` on `cursor-agent acp`: interrupt kills the process, and the
    // daemon relaunches on the same session id.
    cancelTurn: async (transport) => {
      await transport.process.dispose().catch(() => undefined);
    },
    cleanup: async () => {
      await instructions?.remove();
    },
  };
}

/** A session `set_config_option` response carries the option set after the change; `session/new`
 * and `session/load` return the same list. */
function readConfigOptions(response: unknown): SessionConfigOption[] {
  const config = asRecord(response)?.configOptions;
  return Array.isArray(config) ? (config as SessionConfigOption[]) : [];
}

/** The `models.availableModels` list `session/new`/`session/load` returns — composite ids the
 * server accepts verbatim on `session/set_config_option`. */
function readModels(response: unknown): unknown[] {
  const models = asRecord(response)?.models;
  const available = asRecord(models)?.availableModels;
  return Array.isArray(available) ? available : [];
}

/**
 * Applies `runtime.model`+`runtime.reasoning` through the `model` select: the runtime stores a
 * base name and an effort level, the server accepts only a listed composite
 * `name[params]` id — `resolveCursorCompositeId` maps between them. The `mode` select is
 * returned alongside but the runtime carries no mode, so it is never written.
 */
async function applyRuntimeConfig(
  transport: AcpConnection,
  options: AgentSessionOptions,
  sessionId: string,
  config: SessionConfigOption[],
  models: unknown[],
  timeoutMs: number,
  host: CursorAcpRuntimeHost,
): Promise<void> {
  const model = options.runtime?.model;
  if (!model || model === "default") return;
  const baseName = model === "auto" ? "default" : model;
  // The web stores an unchosen effort as "" — undefined, not a variant value.
  const reasoning = options.runtime?.reasoning || undefined;
  let composite = resolveCursorCompositeId(models, baseName, reasoning);
  if (!composite && isOldCursorModelId(baseName)) {
    // An old `cursor-agent models` id kept effort in the name (`-thinking`, `-high`…): fall
    // back to the default model with a warning, not a launch failure.
    host.warnModelFallback?.(model);
    composite = resolveCursorCompositeId(models, "default", undefined);
  }
  if (!composite) throw new RuntimeModelNotFoundError(model);
  const option = config.find((entry) => entry.id === "model" || entry.category === "model");
  // The model select is a launch requirement on this server — a CLI without it has no model
  // surface at all, so the launch fails rather than silently running the default.
  if (!option)
    throw new Error(
      "Cursor exposes no model configuration; upgrade cursor-agent to 2026.10.22 or newer",
    );
  if (!optionOffers(option, composite)) throw new RuntimeModelNotFoundError(model);
  const configured = await acpBounded(
    transport.connection.agent.request("session/set_config_option", {
      sessionId,
      configId: option.id,
      value: composite,
    }),
    timeoutMs,
    "cursor-agent acp session/set_config_option timed out",
  );
  const next = readConfigOptions(configured);
  if (!next.some((entry) => entry.id === option.id && entry.currentValue === composite))
    throw new Error("Cursor did not apply the model selection");
}

function optionOffers(option: SessionConfigOption | undefined, value: string): boolean {
  return (
    option?.type === "select" &&
    option.options.some((entry) =>
      "value" in entry
        ? entry.value === value
        : entry.options.some((child) => child.value === value),
    )
  );
}
