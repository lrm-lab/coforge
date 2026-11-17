import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpApplyRuntimeConfig, acpConfigOptions } from "#src/acp/config-options";
import { acpBounded, acpProcess } from "#src/acp/connection";
import type { AcpRuntimeProfile, AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { OpenCodeAcpRuntimeHost } from "./acp-host";
import { OpenCodeAcpTurnEvents } from "./acp-update-events";
import { OPENCODE_CONFIG_CONTENT_ENV, type OpenCodeInstructions } from "./instructions";
import { isRoutineOpenCodeStderr } from "./stderr";

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
  // `--print-logs` routes the runtime's diagnostics to this process's stderr — its data-dir
  // log is shared by every opencode on the machine, so a failed session open could otherwise
  // only quote other Agents' lines. Stdout stays the clean ACP channel.
  args: ["acp", "--print-logs"],
  // --print-logs makes routine INFO narrative land on stderr every run; only WARN and above —
  // or anything outside the log format — is worth a process-stderr warning.
  routineStderrLine: isRoutineOpenCodeStderr,
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
        const diagnostics = stderrTail.filter((line) => !isRoutineOpenCodeStderr(line));
        if (diagnostics.length > 0) host.stderrHint?.(diagnostics);
      });
      return transport;
    },
    openSession: async (transport, sessionId) => {
      const agent = transport.connection.agent;
      const cwd = options.agentWorkspaceDirectory;
      const resuming = sessionId !== undefined && options.sessionMode !== "create";
      let opened: string | undefined;
      let replaced: string | undefined;
      let configOptions: SessionConfigOption[] = [];
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
          configOptions = acpConfigOptions(loaded);
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
        configOptions = acpConfigOptions(state);
      }
      await acpApplyRuntimeConfig(
        {
          transport,
          sessionId: opened,
          timeoutMs,
          timedOut: "opencode acp session/set_config_option timed out",
          label: "OpenCode",
          missingModel:
            "OpenCode exposes no model configuration; upgrade opencode to 2.1.0 or newer",
        },
        configOptions,
        options.runtime,
      );
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
