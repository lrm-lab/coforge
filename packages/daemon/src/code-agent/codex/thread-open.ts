import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSessionOptions } from "@coforge/agent";
import { AgentSessionRecoveryError, asRecord } from "@lrm/coforge-anvil";

import { JsonlRequestError, type JsonlProcess } from "#src/code-agent/jsonl-process";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

type ThreadResponse = Readonly<Record<string, unknown>>;

export interface OpenedCodexThread {
  threadId: string;
  /** The raw `thread/start` or `thread/resume` result. */
  result: Record<string, unknown> | undefined;
  /** The requested session that could not be resumed and was replaced by a fresh thread. */
  replacedSessionId: string | undefined;
}

/**
 * Starts or resumes the Codex thread for a launch, recovering a thread that will not resume
 * (archived, missing, in use) instead of failing every attempt, then names it after the Agent.
 */
export async function openCodexThread(
  process: JsonlProcess,
  options: AgentSessionOptions,
): Promise<OpenedCodexThread> {
  const sessionId = options.sessionId;
  const open = (resume?: string) => process.request(threadRequest(options, resume));
  const log = { agent_id: options.agentId, runtime_id: options.runtimeId };
  // The resumed thread, or why it could not be: any error that is not a known one is thrown.
  const resume = (id: string) =>
    open(id).then(
      (response) => ({ response, failure: undefined }),
      (error: unknown) => {
        const failure = resumeFailure(error, id);
        if (failure === "active_writer") throw new AgentSessionRecoveryError("session_in_use");
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
    return { response: await open(), replacedSessionId: id };
  };
  const recover = async (
    id: string,
    failure: "missing" | "archived",
  ): Promise<{ response: ThreadResponse; replacedSessionId?: string }> => {
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
    return second.response ? { response: second.response } : replace(id, "still_unavailable");
  };
  const first = sessionId ? await resume(sessionId) : { response: await open() };
  const { response, replacedSessionId } = first.response
    ? { response: first.response, replacedSessionId: undefined }
    : await recover(sessionId!, first.failure!);
  const result = asRecord(response.result);
  const thread = asRecord(result?.thread);
  if (typeof thread?.id !== "string") throw new Error("Codex did not create a thread");
  if (sessionId && !replacedSessionId && thread.id !== sessionId)
    throw new Error("Codex did not resume the requested thread");
  await nameThread(process, options, thread.id, thread.name);
  return { threadId: thread.id, result, replacedSessionId };
}

/**
 * Which known way a resume failed. The active-writer text is seen only as a fragment of the Codex
 * binary (0.163.0), so its code is not assumed; the others are the exact official -32600 replies,
 * never auth/I/O or generic errors.
 */
function resumeFailure(
  error: unknown,
  sessionId: string,
): "active_writer" | "missing" | "archived" | undefined {
  const native = error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
  const message = native?.message;
  if (typeof message !== "string") return undefined;
  if (message.includes(" already has an active writer")) return "active_writer";
  if (native?.code !== -32600) return undefined;
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

function threadRequest(options: AgentSessionOptions, sessionId?: string) {
  return {
    method: sessionId ? "thread/resume" : "thread/start",
    params: {
      ...(sessionId ? { threadId: sessionId } : { ephemeral: false }),
      cwd: options.agentWorkspaceDirectory,
      developerInstructions: options.instructions,
      ...(options.runtime?.model ? { model: options.runtime.model } : {}),
      // Codex's own service tier for this thread; the ordinary tier is the absence of it.
      ...(options.runtime?.fastMode ? { serviceTier: "fast" } : {}),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        ...(options.runtime?.reasoning
          ? { model_reasoning_effort: options.runtime.reasoning }
          : {}),
        // Retain the existing global-config override surface; the approved
        // danger-full-access policy does not use workspace-write restrictions.
        "sandbox_workspace_write.network_access": true,
        allow_login_shell: false,
        shell_environment_policy: {
          inherit: "all",
          ignore_default_excludes: false,
          filters: {
            "COFORGE_*": "include",
            HOME: "include",
            PATH: "include",
            XDG_CONFIG_HOME: "include",
            XDG_DATA_HOME: "include",
            XDG_CACHE_HOME: "include",
            TMPDIR: "include",
            TEMP: "include",
            TMP: "include",
            LANG: "include",
            LC_ALL: "include",
          },
        },
      },
      ...(!sessionId ? { serviceName: "coforge_daemon" } : {}),
    },
  };
}
