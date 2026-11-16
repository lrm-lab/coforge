import type { FetchLike } from "./device-client";
import { serverUrlOf } from "./server-request";
import type { AgentProfile } from "./profile-store";

export type AgentContextView = {
  agent: {
    id: string;
    name: string;
    displayName: string;
    description: string;
    role: string;
    external: boolean;
  };
  workspace: { id: string; slug: string; name: string };
  credential: { id: string } | null;
  capabilities: string[] | null;
  prompt: { text: string } | null;
};

export type ContextProbe =
  | { state: "ok"; context: AgentContextView }
  | { state: "unauthorized" }
  | { state: "unreachable"; detail: string };

function isContextView(value: unknown): value is AgentContextView {
  if (!value || typeof value !== "object") return false;
  const { agent, workspace } = value as Partial<AgentContextView>;
  return typeof agent?.id === "string" && typeof workspace?.slug === "string";
}

/** `GET /context` with the profile's key: the server's own answer about who this key is. */
export async function probeContext(
  profile: Pick<AgentProfile, "serverUrl" | "apiKey">,
  fetchFn: FetchLike = fetch,
): Promise<ContextProbe> {
  let response: Response;
  try {
    response = await fetchFn(serverUrlOf(profile.serverUrl, "/api/agent/v1/context"), {
      headers: { authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { state: "unreachable", detail: "network or timeout" };
  }
  if (response.status === 401) return { state: "unauthorized" };
  if (!response.ok) return { state: "unreachable", detail: `HTTP ${response.status}` };
  const body: unknown = await response.json().catch(() => undefined);
  if (!isContextView(body)) return { state: "unreachable", detail: "unexpected answer" };
  return { state: "ok", context: body };
}
