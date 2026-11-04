import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpBounded, acpProcess } from "#src/acp/connection";
import type { AcpRuntimeProfile, AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import { AntigravityAcpTurnEvents } from "./acp-update-events";

/** How long a production session waits for each bounded ACP answer. */
export const ANTIGRAVITY_ACP_TIMEOUT_MS = 120_000;

/** How many trailing stderr lines reach the host when the process closes. */
const STDERR_TAIL_LINES = 40;

/** `session/load`'s answer when the stored session is gone: a missing native session is
 * replaced with a fresh one and reported; any other failure surfaces. */
const ANTIGRAVITY_SESSION_MISSING_CODE = -32002;

/** Whether the server declares `_meta.antigravity.systemPrompt.append` on `initialize` — the
 * native standing-instructions channel this runtime requires (the launch refuses without it). */
export function antigravitySystemPromptAppendDeclared(response: InitializeResponse): boolean {
  const meta = asRecord(response.agentCapabilities?._meta);
  const antigravity = asRecord(meta?.antigravity);
  const systemPrompt = asRecord(antigravity?.systemPrompt);
  return systemPrompt?.append === true;
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
      const transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
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
    openSession: async (transport, sessionId, _initialized) => {
      const agent = transport.connection.agent;
      const cwd = options.agentWorkspaceDirectory;
      const resuming = sessionId !== undefined;
      let opened: string | undefined;
      let replaced: string | undefined;
      if (resuming) {
        try {
          await acpBounded(
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
          if (!(error instanceof RequestError) || error.code !== ANTIGRAVITY_SESSION_MISSING_CODE)
            throw error;
          replaced = sessionId;
        }
      }
      if (!opened) {
        const state = await acpBounded(
          agent.request("session/new", { cwd, mcpServers: [], _meta: meta }),
          timeoutMs,
          "agy acp session/new timed out",
        );
        opened = nonEmptyString(asRecord(state)?.sessionId);
        if (!opened) throw new Error("agy acp did not create a session");
      }
      // A resumed session returns to the default mode, so `yolo` and the selected model/effort
      // replay on every open.
      await acpBounded(
        agent.request("session/set_mode", { sessionId: opened, modeId: "yolo" }),
        timeoutMs,
        "agy acp session/set_mode timed out",
      );
      const model = options.runtime?.model;
      if (model && model !== "default")
        await acpBounded(
          agent.request("session/set_config_option", {
            sessionId: opened,
            configId: "model",
            value: model,
          }),
          timeoutMs,
          "agy acp session/set_config_option timed out",
        );
      const reasoning = options.runtime?.reasoning;
      if (reasoning)
        await acpBounded(
          agent.request("session/set_config_option", {
            sessionId: opened,
            configId: "thinking_level",
            value: reasoning,
          }),
          timeoutMs,
          "agy acp session/set_config_option timed out",
        );
      return { sessionId: opened, resumable: resuming && !replaced, replacedSessionId: replaced };
    },
    turn: () => new AntigravityAcpTurnEvents(host),
    // `session/cancel` is unimplemented on `agy acp`: interrupt kills the process, and the
    // daemon relaunches on the same session id.
    cancelTurn: async (transport) => {
      await transport.process.dispose().catch(() => undefined);
    },
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
        // Any answered steer reached the model — `end_turn`, `max_tokens` and
        // `max_turn_requests` all end the merged turn with the text consumed. Only a
        // cancellation or a refusal means the notice never landed, and an answer without a
        // stopReason is treated the same way rather than guessed delivered.
        const stopReason = nonEmptyString(asRecord(response)?.stopReason);
        return {
          accepted:
            stopReason !== undefined && stopReason !== "cancelled" && stopReason !== "refusal",
        };
      },
    },
  };
}
