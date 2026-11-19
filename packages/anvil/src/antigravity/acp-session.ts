import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { RuntimeLoginRequiredError } from "#src/contract";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpApplyRuntimeConfig, acpConfigOptions } from "#src/acp/config-options";
import { acpBounded, acpProcess } from "#src/acp/connection";
import type { AcpRuntimeProfile, AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import { antigravityAcpSessionExtraArgs } from "./acp-args";
import { ANTIGRAVITY_AUTH_REQUIRED_CODE } from "./auth";
import { AntigravityAcpTurnEvents } from "./acp-update-events";
import { parseAntigravityQuotaLimit } from "./quota";

export const ANTIGRAVITY_ACP_TIMEOUT_MS = 120_000;

export const ANTIGRAVITY_MAX_INPUT_BYTES = 185_000;

const STDERR_TAIL_LINES = 40;

const ANTIGRAVITY_SESSION_MISSING_CODE = -32002;

const AUTOMATIC_MODE_ID = "auto";

const ANTIGRAVITY_NOT_SIGNED_IN =
  "Antigravity is not signed in: open the Computer page and choose Log in — a browser opens on " +
  "that Computer.";

function antigravitySignInRequired(): RuntimeLoginRequiredError {
  return new RuntimeLoginRequiredError(ANTIGRAVITY_NOT_SIGNED_IN, {
    detailHint: ANTIGRAVITY_NOT_SIGNED_IN,
  });
}

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.ANTIGRAVITY]);

function availableModeIds(state: unknown): string[] {
  const modes = asRecord(asRecord(state)?.modes);
  const available = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
  return available.flatMap((entry) => {
    const id = nonEmptyString(asRecord(entry)?.id);
    return id ? [id] : [];
  });
}

function logAutomaticModeUnavailable(initialized: InitializeResponse, modeIds: string[]): void {
  logger.warning("Antigravity ACP has no automatic permission mode; continuing without set_mode", {
    event: "antigravity_acp:automatic_mode_unavailable",
    agy_version: nonEmptyString(asRecord(asRecord(initialized)?.agentInfo)?.version),
    available_modes: modeIds,
  });
}

export function antigravitySystemPromptAppendDeclared(response: InitializeResponse): boolean {
  const meta = asRecord(response.agentCapabilities?._meta);
  const antigravity = asRecord(meta?.antigravity);
  const systemPrompt = asRecord(antigravity?.systemPrompt);
  return systemPrompt?.append === true;
}

export function antigravitySessionResumeDeclared(response: InitializeResponse): boolean {
  const capabilities = asRecord(response.agentCapabilities?.sessionCapabilities);
  return (
    capabilities?.resume !== undefined &&
    capabilities.resume !== null &&
    capabilities.resume !== false
  );
}

export class UnsupportedOptionError extends Error {
  constructor(option: string) {
    super(`agy acp does not support required option ${option}`);
    this.name = "UnsupportedOptionError";
  }
}

export const ANTIGRAVITY_ACP_PROFILE: AcpRuntimeProfile = {
  args: ["acp"],
  capabilityCheck: (response) => {
    if (!antigravitySystemPromptAppendDeclared(response))
      throw new UnsupportedOptionError("antigravity.systemPrompt.append");
  },
  messages: {
    unsupportedProtocol: "agy acp does not speak the ACP version this session requires",
    closedBeforeConfig: "agy acp closed before the session configured",
    timedOut: "agy acp did not answer in time",
  },
};

export async function createAntigravityAcpSession(
  options: AgentSessionOptions,
  command: readonly string[],
  host: AntigravityAcpRuntimeHost,
  disabledTools?: readonly string[],
  acpTimeoutMs?: number,
): Promise<AgentSession> {
  const timeoutMs = acpTimeoutMs ?? ANTIGRAVITY_ACP_TIMEOUT_MS;
  const profile = antigravitySessionProfile(options, command, host, disabledTools, timeoutMs);
  const session = new AcpSession(profile, options, timeoutMs, (work) =>
    acpBounded(work, timeoutMs, ANTIGRAVITY_ACP_PROFILE.messages.timedOut),
  );
  try {
    await session.open();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

function antigravitySessionProfile(
  options: AgentSessionOptions,
  command: readonly string[],
  host: AntigravityAcpRuntimeHost,
  disabledTools: readonly string[] | undefined,
  timeoutMs: number,
): AcpSessionProfile {
  const meta = {
    antigravity: {
      systemPrompt: { append: options.instructions },
      ...(disabledTools?.length ? { disabledTools } : {}),
    },
  };
  return {
    label: "Antigravity",
    openTransport: (sink) => {
      const stderrTail: string[] = [];
      const environment = host.buildEnvironment(options);
      const transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
        command,
        extraArgs: antigravityAcpSessionExtraArgs(environment),
        cwd: options.agentWorkspaceDirectory,
        environment,
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
    openSession: async (transport, sessionId, initialized) => {
      const agent = transport.connection.agent;
      const cwd = options.agentWorkspaceDirectory;
      const resuming = sessionId !== undefined;
      let opened: string | undefined;
      let replaced: string | undefined;
      let state: unknown;
      if (resuming) {
        let tryLoad = true;
        if (antigravitySessionResumeDeclared(initialized)) {
          try {
            state = await acpBounded(
              agent.request("session/resume", {
                sessionId,
                cwd,
                mcpServers: [],
                _meta: meta,
              }),
              timeoutMs,
              "agy acp session/resume timed out",
            );
            opened = sessionId;
            tryLoad = false;
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            if (error.code === ANTIGRAVITY_AUTH_REQUIRED_CODE) throw antigravitySignInRequired();
            if (error.code === ANTIGRAVITY_SESSION_MISSING_CODE) {
              replaced = sessionId;
              tryLoad = false;
            } else if (error.code === -32601 || error.code === -32602) {
              logger.warning(
                "Antigravity ACP session/resume unsupported; falling back to session/load",
                { event: "antigravity_acp:session_resume_fallback", code: error.code },
              );
            } else {
              throw error;
            }
          }
        }
        if (tryLoad) {
          try {
            state = await acpBounded(
              agent.request("session/load", {
                sessionId,
                cwd,
                mcpServers: [],
                _meta: meta,
              }),
              timeoutMs,
              "agy acp session/load timed out",
            );
            opened = sessionId;
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            if (error.code === ANTIGRAVITY_AUTH_REQUIRED_CODE) throw antigravitySignInRequired();
            if (error.code !== ANTIGRAVITY_SESSION_MISSING_CODE) throw error;
            replaced = sessionId;
          }
        }
      }
      if (!opened) {
        try {
          state = await acpBounded(
            agent.request("session/new", { cwd, mcpServers: [], _meta: meta }),
            timeoutMs,
            "agy acp session/new timed out",
          );
        } catch (error) {
          if (error instanceof RequestError && error.code === ANTIGRAVITY_AUTH_REQUIRED_CODE)
            throw antigravitySignInRequired();
          throw error;
        }
        opened = nonEmptyString(asRecord(state)?.sessionId);
        if (!opened) throw new Error("agy acp did not create a session");
      }
      const modeIds = availableModeIds(state);
      if (modeIds.includes(AUTOMATIC_MODE_ID))
        await acpBounded(
          agent.request("session/set_mode", { sessionId: opened, modeId: AUTOMATIC_MODE_ID }),
          timeoutMs,
          "agy acp session/set_mode timed out",
        );
      else logAutomaticModeUnavailable(initialized, modeIds);
      await acpApplyRuntimeConfig(
        {
          transport,
          sessionId: opened,
          timeoutMs,
          timedOut: "agy acp session/set_config_option timed out",
          label: "agy acp",
        },
        acpConfigOptions(state),
        options.runtime,
      );
      return { sessionId: opened, resumable: resuming && !replaced, replacedSessionId: replaced };
    },
    turn: () => new AntigravityAcpTurnEvents(host),
    maxInputBytes: ANTIGRAVITY_MAX_INPUT_BYTES,
    annotateFailure: (event, error) => {
      if (!(error instanceof RequestError)) return event;
      const providerLimit = parseAntigravityQuotaLimit(event.message);
      return providerLimit ? { ...event, providerLimit } : event;
    },
    steer: {
      unboundedRequest: true,
      settlesTurn: true,
      isRefusalError: (error) => error instanceof RequestError && error.code === -32602,
      request: (text, sessionId) => ({
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text }] },
      }),
      accepted: (response) => {
        const stopReason = nonEmptyString(asRecord(response)?.stopReason);
        return {
          accepted:
            stopReason !== undefined && stopReason !== "cancelled" && stopReason !== "refusal",
        };
      },
    },
  };
}
