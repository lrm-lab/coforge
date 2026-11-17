import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpConfigOptions, acpSelectValues } from "#src/acp/config-options";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import type { AcpRuntimeProfile, AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import { RuntimeModelNotFoundError } from "#src/contract";
import type { DroidAcpRuntimeHost } from "./acp-host";
import { DroidAcpTurnEvents } from "./acp-update-events";
import type { DroidInstructions } from "./instructions";

export const DROID_ACP_TIMEOUT_MS = 120_000;

const STDERR_TAIL_LINES = 40;

const DROID_SESSION_MISSING_CODE = -32602;

export function droidLoadSessionDeclared(response: InitializeResponse): boolean {
  return response.agentCapabilities?.loadSession === true;
}

export class DroidUnsupportedOptionError extends Error {
  constructor(option: string) {
    super(`droid acp does not support required option ${option}`);
    this.name = "DroidUnsupportedOptionError";
  }
}

export const DROID_ACP_PROFILE: AcpRuntimeProfile = {
  args: ["exec", "--output-format", "acp"],
  capabilityCheck: (response) => {
    if (!droidLoadSessionDeclared(response)) throw new DroidUnsupportedOptionError("loadSession");
  },
  messages: {
    unsupportedProtocol: "droid acp does not speak the ACP version this session requires",
    closedBeforeConfig: "droid acp closed before the session configured",
    timedOut: "droid acp did not answer in time",
  },
};

export async function createDroidAcpSession(
  options: AgentSessionOptions,
  command: readonly string[],
  host: DroidAcpRuntimeHost,
  instructions: DroidInstructions | undefined,
  acpTimeoutMs?: number,
): Promise<AgentSession> {
  const timeoutMs = acpTimeoutMs ?? DROID_ACP_TIMEOUT_MS;
  const profile = droidSessionProfile(options, command, host, instructions, timeoutMs);
  const session = new AcpSession(profile, options, timeoutMs, (work) =>
    acpBounded(work, timeoutMs, DROID_ACP_PROFILE.messages.timedOut),
  );
  try {
    await session.open();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

function droidSessionProfile(
  options: AgentSessionOptions,
  command: readonly string[],
  host: DroidAcpRuntimeHost,
  instructions: DroidInstructions | undefined,
  timeoutMs: number,
): AcpSessionProfile {
  return {
    label: "Droid",
    openTransport: (sink) => {
      const stderrTail: string[] = [];
      const transport = acpProcess(DROID_ACP_PROFILE, {
        command,
        extraArgs: instructions ? ["--append-system-prompt-file", instructions.path] : [],
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
      if (resuming) {
        try {
          const loaded = await acpBounded(
            agent.request("session/load", {
              sessionId,
              cwd,
              mcpServers: [],
            }),
            timeoutMs,
            "droid acp session/load timed out",
          );
          opened = sessionId;
          configOptions = acpConfigOptions(loaded);
        } catch (error) {
          const missing =
            error instanceof RequestError &&
            error.code === DROID_SESSION_MISSING_CODE &&
            /unknown session identifier|session .{0,80}not found/i.test(
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
          "droid acp session/new timed out",
        );
        opened = nonEmptyString(asRecord(state)?.sessionId);
        if (!opened) throw new Error("droid acp did not create a session");
        configOptions = acpConfigOptions(state);
      }
      await applyRuntimeConfig(transport, options, opened, configOptions, timeoutMs);
      return { sessionId: opened, resumable: resuming && !replaced, replacedSessionId: replaced };
    },
    turn: () => new DroidAcpTurnEvents(host),
    cancelTurn: async (transport) => {
      await transport.process.dispose().catch(() => undefined);
    },
    cleanup: async () => {
      await instructions?.remove();
    },
  };
}

async function applyRuntimeConfig(
  transport: AcpConnection,
  options: AgentSessionOptions,
  sessionId: string,
  initial: unknown[],
  timeoutMs: number,
): Promise<void> {
  const model = options.runtime?.model;
  const reasoning = options.runtime?.reasoning || undefined;
  if ((!model || model === "default") && !reasoning) return;
  let config = initial as SessionConfigOption[];
  const select = async (id: string, value: string) => {
    const option = config.find((entry) => entry.id === id || entry.category === id);
    if (!acpSelectValues(option).includes(value)) {
      if (id === "model") throw new RuntimeModelNotFoundError(value);
      throw new Error(`Droid ${id} selection is unavailable`);
    }
    const configured = await acpBounded(
      transport.connection.agent.request("session/set_config_option", {
        sessionId,
        configId: option!.id,
        value,
      }),
      timeoutMs,
      "droid acp session/set_config_option timed out",
    );
    config = acpConfigOptions(configured);
    if (!config.some((entry) => entry.id === option!.id && entry.currentValue === value))
      throw new Error(`Droid did not apply ${id}`);
  };
  if (model && model !== "default") {
    if (!config.some((entry) => entry.id === "model" || entry.category === "model"))
      throw new Error("Droid exposes no model configuration; upgrade droid to 1.4.1 or newer");
    await select("model", model);
  }
  if (!reasoning) return;
  const effort = config.find((entry) => entry.category === "thought_level");
  if (effort) await select(effort.id, reasoning);
}
