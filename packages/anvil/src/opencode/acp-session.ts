import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile, AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import { RuntimeModelNotFoundError } from "#src/contract";
import type { OpenCodeAcpRuntimeHost } from "./acp-host";
import { OpenCodeAcpTurnEvents } from "./acp-update-events";
import { OPENCODE_CONFIG_CONTENT_ENV, type OpenCodeInstructions } from "./instructions";

/** How long a production session waits for each bounded ACP answer. */
export const OPENCODE_ACP_TIMEOUT_MS = 120_000;

/** How many trailing stderr lines reach the host when the process closes. */
const STDERR_TAIL_LINES = 40;

/** `session/load` answers `Invalid params: session not found` (`-32602`) when the stored
 * session is gone — a missing native session is replaced with a fresh one and reported; any
 * other failure surfaces. Verified on opencode 2.1.0. */
const OPENCODE_SESSION_MISSING_CODE = -32602;

/** Whether the server advertises `loadSession` — the resume this launch contract needs. */
export function openCodeLoadSessionDeclared(response: InitializeResponse): boolean {
  return response.agentCapabilities?.loadSession === true;
}

export class OpenCodeUnsupportedOptionError extends Error {
  constructor(option: string) {
    super(`opencode acp does not support required option ${option}`);
    this.name = "OpenCodeUnsupportedOptionError";
  }
}

export const OPENCODE_ACP_PROFILE: AcpRuntimeProfile = {
  args: ["acp"],
  capabilityCheck: (response) => {
    if (!openCodeLoadSessionDeclared(response))
      throw new OpenCodeUnsupportedOptionError("loadSession");
  },
  messages: {
    unsupportedProtocol: "opencode acp does not speak the ACP version this session requires",
    closedBeforeConfig: "opencode acp closed before the session configured",
    timedOut: "opencode acp did not answer in time",
  },
};

export async function createOpenCodeAcpSession(
  options: AgentSessionOptions,
  command: readonly string[],
  host: OpenCodeAcpRuntimeHost,
  instructions: OpenCodeInstructions,
  acpTimeoutMs?: number,
): Promise<AgentSession> {
  const timeoutMs = acpTimeoutMs ?? OPENCODE_ACP_TIMEOUT_MS;
  const profile = openCodeSessionProfile(options, command, host, instructions, timeoutMs);
  const session = new AcpSession(profile, options, timeoutMs, (work) =>
    acpBounded(work, timeoutMs, OPENCODE_ACP_PROFILE.messages.timedOut),
  );
  try {
    await session.open();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

function openCodeSessionProfile(
  options: AgentSessionOptions,
  command: readonly string[],
  host: OpenCodeAcpRuntimeHost,
  instructions: OpenCodeInstructions,
  timeoutMs: number,
): AcpSessionProfile {
  return {
    label: "OpenCode",
    openTransport: (sink) => {
      const stderrTail: string[] = [];
      const transport = acpProcess(OPENCODE_ACP_PROFILE, {
        command,
        cwd: options.agentWorkspaceDirectory,
        environment: {
          ...host.buildEnvironment(options),
          // Standing instructions ride the process environment, never an ACP field: opencode has
          // no system-prompt channel, and `OPENCODE_CONFIG_CONTENT` appends the private file
          // after the project's own instructions on every launch (CLI 2.0.30+).
          [OPENCODE_CONFIG_CONTENT_ENV]: instructions.configContent,
        },
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
      if (resuming) {
        try {
          const loaded = await acpBounded(
            agent.request("session/load", {
              sessionId,
              cwd,
              mcpServers: [],
            }),
            timeoutMs,
            "opencode acp session/load timed out",
          );
          opened = sessionId;
          configOptions = readConfigOptions(loaded);
        } catch (error) {
          const missing =
            error instanceof RequestError &&
            error.code === OPENCODE_SESSION_MISSING_CODE &&
            /session not found/i.test(error.message);
          if (!missing) throw error;
          replaced = sessionId;
        }
      }
      if (!opened) {
        const state = await acpBounded(
          agent.request("session/new", { cwd, mcpServers: [] }),
          timeoutMs,
          "opencode acp session/new timed out",
        );
        opened = nonEmptyString(asRecord(state)?.sessionId);
        if (!opened) throw new Error("opencode acp did not create a session");
        configOptions = readConfigOptions(state);
      }
      await applyRuntimeConfig(transport, options, opened, configOptions, timeoutMs);
      return { sessionId: opened, resumable: resuming && !replaced, replacedSessionId: replaced };
    },
    turn: () => new OpenCodeAcpTurnEvents(host),
    // `session/cancel` is unimplemented on `opencode acp`: interrupt kills the process, and the
    // daemon relaunches on the same session id.
    cancelTurn: async (transport) => {
      await transport.process.dispose().catch(() => undefined);
    },
    cleanup: async () => {
      await instructions.remove();
    },
  };
}

/** A session `set_config_option` response carries the option set after the change. */
function readConfigOptions(response: unknown): SessionConfigOption[] {
  const config = asRecord(response)?.configOptions;
  return Array.isArray(config) ? (config as SessionConfigOption[]) : [];
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

/** Applies `runtime.model` through the `model` select, then `runtime.reasoning` through the
 * `thought_level` select a model switch publishes. `session/new` and `session/load` both
 * return the select list. */
async function applyRuntimeConfig(
  transport: AcpConnection,
  options: AgentSessionOptions,
  sessionId: string,
  initial: unknown[],
  timeoutMs: number,
): Promise<void> {
  const model = options.runtime?.model;
  const reasoning = options.runtime?.reasoning;
  if ((!model || model === "default") && !reasoning) return;
  let config = initial as SessionConfigOption[];
  const select = async (id: string, value: string) => {
    const option = config.find((entry) => entry.id === id || entry.category === id);
    if (!optionOffers(option, value)) {
      if (id === "model") throw new RuntimeModelNotFoundError(value);
      throw new Error(`OpenCode ${id} selection is unavailable`);
    }
    const configured = await acpBounded(
      transport.connection.agent.request("session/set_config_option", {
        sessionId,
        configId: option!.id,
        value,
      }),
      timeoutMs,
      "opencode acp session/set_config_option timed out",
    );
    config = readConfigOptions(configured);
    if (!config.some((entry) => entry.id === option!.id && entry.currentValue === value))
      throw new Error(`OpenCode did not apply ${id}`);
  };
  if (model && model !== "default") {
    // opencode publishes its options on `session/new`/`session/load` itself — a missing `model`
    // select means a CLI without the config surface, so fail instead of waiting for options
    // that never arrive.
    if (!config.some((entry) => entry.id === "model" || entry.category === "model"))
      throw new Error(
        "OpenCode exposes no model configuration; upgrade opencode to 2.1.0 or newer",
      );
    await select("model", model);
  }
  if (!reasoning) return;
  const effort = config.find((entry) => entry.category === "thought_level");
  // No effort option after the model applies leaves that model's own default; a present option
  // that lacks the value fails the launch (the stored selection no longer exists).
  if (effort) await select(effort.id, reasoning);
}
