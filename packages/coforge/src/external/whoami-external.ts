import { CliError } from "../cli-error";
import { formatWhoami, type WhoamiInvocation, type WhoamiResult } from "../whoami";
import { probeContext } from "./agent-context";
import { invalidCredentialError } from "./refusal";
import type { ExternalSession } from "./profile-store";

function unconfirmed(local: WhoamiResult, code: string, error: string): WhoamiResult {
  return { ...local, serverConfirmed: false, serverErrorCode: code, serverError: error };
}

/** `coforge whoami` for an external Agent: the profile's own record, confirmed by the server's
 * `GET /context`; `--prompt` prints the operating guide the server holds for the Agent. */
export async function runExternalWhoami(
  session: ExternalSession,
  invocation: WhoamiInvocation,
): Promise<string> {
  const { profile } = session;
  const probe = await probeContext(profile);
  if (invocation.prompt) {
    if (probe.state === "unauthorized") throw invalidCredentialError();
    if (probe.state === "unreachable")
      throw new CliError({
        code: "WHOAMI_FAILED",
        message: `Could not reach the server (${probe.detail}).`,
        retryable: true,
      });
    const text = probe.context.prompt?.text;
    if (!text)
      throw new CliError({
        code: "PROMPT_UNAVAILABLE",
        message: "The server has no operating guide for this Agent yet.",
        retryable: false,
      });
    return text;
  }
  const local: WhoamiResult = {
    agentId: profile.agentId,
    agentName: profile.agentName,
    workspaceId: profile.workspaceId,
    workspaceSlug: profile.workspaceSlug,
    serverUrl: profile.serverUrl,
    profile: { slug: session.slug, path: session.path },
    clientMode: "external",
    credentialSource: "profile",
    credential: { source: "profile", present: true, redacted: `${profile.apiKey.slice(0, 4)}…` },
  };
  let result: WhoamiResult;
  if (probe.state === "ok") {
    const { agent, workspace } = probe.context;
    if (agent.id !== profile.agentId)
      throw new CliError({
        code: "IDENTITY_MISMATCH",
        message: `The server says this key belongs to agent ${agent.id}, not the profile's ${profile.agentId}.`,
        retryable: false,
      });
    result = {
      ...local,
      workspaceName: workspace.name,
      serverConfirmed: true,
      server: {
        agent: {
          id: agent.id,
          name: agent.name,
          displayName: agent.displayName,
          description: agent.description,
          role: agent.role,
        },
      },
    };
  } else if (probe.state === "unauthorized")
    result = unconfirmed(
      local,
      "EXTERNAL_CREDENTIAL_INVALID",
      "The server rejected this Agent's key; it was revoked or replaced. Run `coforge agent login` again for this profile.",
    );
  else
    result = unconfirmed(
      local,
      "WHOAMI_FAILED",
      `Could not confirm identity with the server (${probe.detail}). Any local context printed is unconfirmed.`,
    );
  const output = invocation.json
    ? JSON.stringify({ ok: result.serverConfirmed === true, data: result })
    : formatWhoami(result);
  if (result.serverConfirmed) return output;
  throw new CliError({
    code: result.serverErrorCode ?? "WHOAMI_FAILED",
    message: result.serverError ?? "The server did not confirm this identity.",
    retryable: false,
    stdoutText: output,
  });
}
