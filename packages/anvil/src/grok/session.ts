import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { acpBounded, type AcpConnection } from "#src/acp/connection";
import type { AcpSessionProfile } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";
import { asRecord, nonEmptyString } from "#src/json-record";
import { grokConnection, GROK_PROFILE } from "./connection";
import { GrokTurnEvents } from "./update-events";
import type { GrokRuntimeHost } from "./host";

/** How long a production session waits for each ACP answer. */
export const ACP_TIMEOUT_MS = 30_000;

// Stop reasons that end a turn normally; `cancelled` is an interruption and any other one failed.
const COMPLETED_STOP_REASONS = new Set<unknown>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);

export async function createGrokSession(
  options: AgentSessionOptions,
  command: readonly string[],
  acpTimeoutMs: number,
  host: GrokRuntimeHost,
): Promise<AgentSession> {
  const session = new AcpSession(
    grokSessionProfile(options, command, acpTimeoutMs, host),
    options,
    acpTimeoutMs,
    (work) => acpBounded(work, acpTimeoutMs, GROK_PROFILE.messages.timedOut),
  );
  try {
    await session.open();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

function grokSessionProfile(
  options: AgentSessionOptions,
  command: readonly string[],
  acpTimeoutMs: number,
  host: GrokRuntimeHost,
): AcpSessionProfile {
  const argv = [...command, "--trust", "agent", "--no-leader", "--always-approve"];
  if (options.runtime?.model && options.runtime.model !== "default")
    argv.push("--model", options.runtime.model);
  if (options.runtime?.reasoning) argv.push("--reasoning-effort", options.runtime.reasoning);
  argv.push("stdio");
  return {
    label: "Grok",
    openTransport: (sink) =>
      grokConnection(
        argv,
        options.agentWorkspaceDirectory,
        host.buildSessionEnvironment(options),
        host,
        (method, params) => {
          if (method !== "session/update") {
            sink.notification(method, params);
            return;
          }
          const sessionId = nonEmptyString(params.sessionId);
          const update = asRecord(params.update);
          if (sessionId && update) sink.update(sessionId, update);
        },
        (request) => sink.permission(request),
        () => sink.promptWritten(),
      ),
    // Grok authenticates before a session exists, and only the methods its initialize answer
    // advertised can be used.
    beforeSession: async (transport, initialized) => {
      const methods = initialized.authMethods ?? [];
      const preferred = nonEmptyString(asRecord(initialized._meta)?.defaultAuthMethodId);
      const method =
        methods.find(
          (m) => m.id === preferred && (m.id === "cached_token" || m.id === "x.ai.api_key"),
        ) ??
        methods.find((m) => m.id === "cached_token") ??
        methods.find((m) => m.id === "x.ai.api_key");
      if (!method) throw new Error("Grok noninteractive authentication is unavailable");
      await acpBounded(
        transport.connection.agent.request("authenticate", {
          methodId: method.id,
          _meta: { headless: true },
        }),
        acpTimeoutMs,
        GROK_PROFILE.messages.timedOut,
      );
    },
    openSession: (transport, sessionId, initialized) =>
      openGrokSession(transport, sessionId, initialized, options, acpTimeoutMs),
    turn: () => new GrokTurnEvents(host),
    // Grok names the prompt it runs, and its queue notifications carry that same id.
    promptMeta: (turnId) => ({ promptId: turnId }),
    // A prompt Grok queues or starts is delivered before its first output arrives.
    promptAdmitted: (method, params, promptId) => {
      if (method !== "_x.ai/queue/changed") return false;
      if (nonEmptyString(params.runningPromptId) === promptId) return true;
      return (Array.isArray(params.entries) ? params.entries : []).some(
        (entry) => nonEmptyString(asRecord(entry)?.id) === promptId,
      );
    },
    // A turn that stops at its token limit or a native turn limit is a normal end for Grok.
    stopStatus: (reason) =>
      COMPLETED_STOP_REASONS.has(reason)
        ? { status: "completed" }
        : reason === "cancelled"
          ? { status: "interrupted" }
          : { status: "failed", error: `Grok stopped the turn (${reason})` },
    admissionTimeoutMs: acpTimeoutMs,
    steer: {
      request: (text, sessionId) => ({
        method: "_x.ai/interject",
        params: { sessionId, text, interjectionId: crypto.randomUUID() },
      }),
      // Measured on grok 1.0.70: an interjection Grok holds answers `status: "queued"`; the only
      // refusal is a JSON-RPC error, which the session reports undelivered.
      accepted: (response) => ({
        accepted: asRecord(asRecord(response)?.result)?.status === "queued",
      }),
      // A queued interjection whose turn ends before injection is run by Grok as its own
      // `interject-fallback-<uuid>` turn. That turn carries no `session/prompt` answer, so it is
      // adopted here and settled by its own `turn_completed`.
      nativeTurn: (method, params, ownPromptId) => grokNativeTurn(method, params, ownPromptId),
    },
  };
}

async function openGrokSession(
  transport: AcpConnection,
  sessionId: string | undefined,
  initialized: InitializeResponse,
  options: AgentSessionOptions,
  acpTimeoutMs: number,
) {
  const agent = transport.connection.agent;
  const canLoad = initialized.agentCapabilities?.loadSession === true;
  const params = { cwd: options.agentWorkspaceDirectory, mcpServers: [] };
  // The instructions replace Grok's native system prompt on new and on load, so a resumed
  // session runs the current ones. Grok ignores a blank override, so none is sent.
  const meta = {
    yoloMode: true,
    ...(options.instructions.trim() ? { systemPromptOverride: options.instructions } : {}),
  };
  let resuming = !!sessionId && options.sessionMode !== "create";
  let replaced: string | undefined;
  const create = () =>
    acpBounded(
      agent.request("session/new", {
        ...params,
        _meta: {
          ...meta,
          ...(!replaced && sessionId ? { sessionId } : {}),
        },
      }),
      acpTimeoutMs,
      GROK_PROFILE.messages.timedOut,
    );
  const load = async () => {
    if (!canLoad) throw new Error("Grok cannot resume sessions: ACP loadSession is unavailable");
    try {
      return await acpBounded(
        agent.request("session/load", {
          ...params,
          sessionId: sessionId!,
          _meta: meta,
        }),
        acpTimeoutMs,
        GROK_PROFILE.messages.timedOut,
      );
    } catch (error) {
      // Only a missing session is replaced. Grok reports a local miss whose remote pull 404s,
      // fails or is not configured as -32603 with data.code FS_NOT_FOUND. Other I/O failures
      // carry another data.code; any failure but that one keeps the identity and fails launch.
      const native = asRecord(error);
      if (native?.code !== -32603 || asRecord(native.data)?.code !== "FS_NOT_FOUND") throw error;
      replaced = sessionId;
      resuming = false;
      return create();
    }
  };
  const state = resuming ? await load() : await create();
  const created = resuming ? sessionId! : "sessionId" in state ? state.sessionId : undefined;
  if (typeof created !== "string" || !created.trim())
    throw new Error("Grok did not create a session");
  const selected = options.runtime?.model;
  const modelId =
    selected && selected !== "default"
      ? selected
      : nonEmptyString(asRecord(asRecord(state)?.models)?.currentModelId);
  if ((selected && selected !== "default") || options.runtime?.reasoning) {
    if (!modelId) throw new Error("Grok current model is unavailable");
    await acpBounded(
      agent.request("session/set_model", {
        sessionId: created,
        modelId,
        ...(options.runtime?.reasoning
          ? { _meta: { reasoningEffort: options.runtime.reasoning } }
          : {}),
      }),
      acpTimeoutMs,
      GROK_PROFILE.messages.timedOut,
    );
  }
  return { sessionId: created, resumable: resuming, replacedSessionId: replaced };
}

/** The turn Grok started itself for an accepted interjection whose previous turn had ended. */
function grokNativeTurn(
  method: string,
  params: Readonly<Record<string, unknown>>,
  ownPromptId: string | undefined,
) {
  if (method === "_x.ai/queue/changed") {
    const running = nonEmptyString(params.runningPromptId);
    return running && running !== ownPromptId ? { promptId: running } : undefined;
  }
  if (method !== "_x.ai/session_notification") return undefined;
  const update = asRecord(params.update);
  if (update?.sessionUpdate !== "turn_completed") return undefined;
  const promptId = nonEmptyString(update.prompt_id);
  if (!promptId || promptId === ownPromptId) return undefined;
  const reason = update.stop_reason;
  const detail = nonEmptyString(update.agent_result);
  const status = COMPLETED_STOP_REASONS.has(reason)
    ? ("completed" as const)
    : reason === "cancelled"
      ? ("interrupted" as const)
      : ("failed" as const);
  return {
    promptId,
    end: {
      status,
      ...(status === "failed"
        ? {
            error: {
              type: "error" as const,
              message: detail ?? `Grok stopped the turn (${String(reason)})`,
              providerErrorReason: typeof reason === "string" ? reason : "unknown_stop_reason",
            },
          }
        : {}),
    },
  };
}
