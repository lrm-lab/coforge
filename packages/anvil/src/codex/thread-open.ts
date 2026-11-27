import { selectsCodexCompatible } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { CODEX_COMPATIBLE_NATIVE_PROVIDER } from "./provider-support";
import { createHash } from "node:crypto";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSessionOptions } from "@coforge/agent";
import { asRecord, isVersionBelow, JsonlRequestError } from "@lrm/coforge-anvil";
import { type JsonlProcess } from "@lrm/coforge-anvil/execution";

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

type ThreadResponse = Readonly<Record<string, unknown>>;

export interface OpenedCodexThread {
  threadId: string;
  /** The raw `thread/start` or `thread/resume` result. */
  result: Record<string, unknown> | undefined;
  /** The requested session that could not be resumed and was replaced by a fresh thread. */
  replacedSessionId: string | undefined;
  /** A user-visible warning explaining why the requested session was replaced. */
  replacementWarning: string | undefined;
}

/**
 * Starts or resumes the Codex thread for a launch, recovering a thread that will not resume
 * (archived, missing, in use) instead of failing every attempt, then names it after the Agent.
 *
 * `reasoningSummary` is the reasoning-summary setting to request; `undefined` leaves it to
 * Codex, which is what the user's own configuration asks for when it chooses one.
 */
export async function openCodexThread(
  process: JsonlProcess,
  options: AgentSessionOptions,
  environment: Readonly<Record<string, string>>,
  reasoningSummary?: string,
  appServerVersion?: string,
): Promise<OpenedCodexThread> {
  const sessionId = options.sessionId;
  const compatible = selectsCodexCompatible(RUNTIME_PROVIDER.CODEX, options.runtime?.modelProvider);
  const matchesProvider = (result: ThreadResponse | undefined) =>
    compatible === (result?.modelProvider === CODEX_COMPATIBLE_NATIVE_PROVIDER);
  const serviceTier = options.runtime?.fastMode ? "fast" : standardServiceTier(appServerVersion);
  const open = (resume?: string) =>
    process.request(threadRequest(options, environment, serviceTier, resume, reasoningSummary));
  const log = { agent_id: options.agentId, runtime_id: options.runtimeId };
  // The resumed thread, or why it could not be: any error that is not a known one is thrown.
  const resume = (id: string) =>
    open(id).then(
      (response) =>
        matchesProvider(asRecord(response.result))
          ? { response, failure: undefined }
          : { response: undefined, failure: "provider_changed" as const },
      (error: unknown) => {
        const failure = resumeFailure(error, id, compatible);
        if (!failure) throw error;
        return { response: undefined, failure };
      },
    );
  const replace = async (id: string, reason: string) => {
    logger.info("Codex thread could not be resumed; starting a fresh thread", {
      event: "codex.thread.resume_replaced",
      ...log,
      reason,
    });
    return {
      response: await open(),
      replacedSessionId: id,
      replacementWarning:
        reason === "active_writer"
          ? "Codex could not resume its previous thread because another writer is active; Raft started a fresh Codex thread.\n\nUse Raft conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded."
          : reason === "provider_changed"
            ? "Codex started a new session after the provider changed. Prior messages remain available in CoForge."
            : undefined,
    };
  };
  const recover = async (
    id: string,
    failure: "missing" | "archived",
  ): Promise<{
    response: ThreadResponse;
    replacedSessionId?: string;
    replacementWarning?: string;
  }> => {
    if (failure === "missing") return replace(id, "missing");
    try {
      await process.request({ method: "thread/unarchive", params: { threadId: id } });
    } catch {
      return replace(id, "unarchive_failed");
    }
    logger.info("Codex thread was archived and has been unarchived", {
      event: "codex.thread.unarchived",
      ...log,
    });
    const second = await resume(id);
    if (second.response) return { response: second.response };
    return replace(
      id,
      second.failure === "active_writer" || second.failure === "provider_changed"
        ? second.failure
        : "still_unavailable",
    );
  };
  const first = sessionId ? await resume(sessionId) : { response: await open() };
  const replacement = first.response
    ? {
        response: first.response,
        replacedSessionId: undefined,
        replacementWarning: undefined,
      }
    : first.failure === "active_writer" || first.failure === "provider_changed"
      ? await replace(sessionId!, first.failure)
      : await recover(sessionId!, first.failure!);
  const { response, replacedSessionId, replacementWarning } = replacement;
  const result = asRecord(response.result);
  if (!matchesProvider(result)) throw new Error("Codex did not select the requested provider");
  const thread = asRecord(result?.thread);
  if (typeof thread?.id !== "string") throw new Error("Codex did not create a thread");
  if (sessionId && !replacedSessionId && thread.id !== sessionId)
    throw new Error("Codex did not resume the requested thread");
  const instructionsBytes = Buffer.byteLength(options.instructions, "utf8");
  logger.info("Codex opened thread with developer instructions", {
    event: "codex.thread.instructions_shape",
    ...log,
    thread_id: thread.id,
    method: sessionId && !replacedSessionId ? "thread/resume" : "thread/start",
    developer_instructions_utf8_bytes: instructionsBytes,
    developer_instructions_sha256: createHash("sha256").update(options.instructions).digest("hex"),
    ...(appServerVersion ? { app_server_version: appServerVersion } : {}),
  });
  await nameThread(process, options, thread.id, thread.name);
  return { threadId: thread.id, result, replacedSessionId, replacementWarning };
}

/**
 * Which known way a resume failed. The active-writer text is seen only as a fragment of the Codex
 * binary (0.163.0), so its code is not assumed; the others are the exact official -32600 replies,
 * never auth/I/O or generic errors.
 */
function resumeFailure(
  error: unknown,
  sessionId: string,
  compatible: boolean,
): "active_writer" | "missing" | "archived" | "provider_changed" | undefined {
  const native = error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
  const message = native?.message;
  if (typeof message !== "string") return undefined;
  if (message.includes(" already has an active writer")) return "active_writer";
  if (native?.code !== -32600) return undefined;
  const unavailableProvider =
    /^This chat uses model provider “([^”]+)”, which is no longer configured\. Restore this provider’s configuration to continue\.$/u.exec(
      message,
    )?.[1];
  if (
    unavailableProvider &&
    (compatible || unavailableProvider === CODEX_COMPATIBLE_NATIVE_PROVIDER)
  )
    return "provider_changed";
  if (message === `no rollout found for thread id ${sessionId}`) return "missing";
  return message.startsWith(`session ${sessionId} is archived`) ? "archived" : undefined;
}

/** Best effort: an older Codex without `thread/name/set` or a rejected name never fails a launch. */
async function nameThread(
  process: JsonlProcess,
  options: AgentSessionOptions,
  threadId: string,
  existing: unknown,
): Promise<void> {
  if (typeof existing === "string" && existing) return;
  const agentName = options.environment?.COFORGE_CURRENT_AGENT_NAME?.trim();
  if (!agentName) return;
  try {
    await process.request({
      method: "thread/name/set",
      params: { threadId, name: `CoForge · ${agentName}` },
    });
  } catch {
    logger.debug("Codex thread could not be named", {
      event: "codex.thread.name_failed",
      agent_id: options.agentId,
      runtime_id: options.runtimeId,
    });
  }
}

const CODEX_EXPLICIT_STANDARD_TIER_MINIMUM_VERSION = "0.133.0";

function standardServiceTier(version: string | undefined): "default" | null {
  if (!version) return null;
  const [stableVersion = "", prerelease] = version.split("-", 2);
  const minimum = CODEX_EXPLICIT_STANDARD_TIER_MINIMUM_VERSION;
  if (isVersionBelow(stableVersion, minimum) || (stableVersion === minimum && prerelease))
    return null;
  return "default";
}
function threadRequest(
  options: AgentSessionOptions,
  environment: Readonly<Record<string, string>>,
  serviceTier: "fast" | "default" | null,
  sessionId?: string,
  reasoningSummary?: string,
) {
  return {
    method: sessionId ? "thread/resume" : "thread/start",
    params: {
      ...(sessionId ? { threadId: sessionId } : { ephemeral: false }),
      cwd: options.agentWorkspaceDirectory,
      developerInstructions: options.instructions,
      ...(options.runtime?.model ? { model: options.runtime.model } : {}),
      serviceTier,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        ...(options.runtime?.reasoning
          ? { model_reasoning_effort: options.runtime.reasoning }
          : {}),
        ...(reasoningSummary ? { model_reasoning_summary: reasoningSummary } : {}),
        "features.memories": false,
        "memories.use_memories": false,
        "memories.generate_memories": false,
        // Retain the existing global-config override surface; the approved
        // danger-full-access policy does not use workspace-write restrictions.
        "sandbox_workspace_write.network_access": true,
        allow_login_shell: false,
        // An include allowlist once dropped XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS,
        // leaving systemctl --user without its Linux session bus. Keep broad inheritance
        // and default secret exclusions; restore only host-generated Git config keys.
        shell_environment_policy: {
          inherit: "all",
          ignore_default_excludes: false,
          set: Object.fromEntries(
            Object.entries(environment).filter(([name]) => /^GIT_CONFIG_KEY_\d+$/.test(name)),
          ),
        },
      },
      ...(!sessionId ? { serviceName: "coforge_daemon" } : {}),
    },
  };
}
