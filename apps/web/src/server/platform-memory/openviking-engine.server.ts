import type { MemoryWrite } from "@lrm/coforge-sdk/agent";
import { decodePlatformMemoryCommand } from "@lrm/coforge-sdk/agent";
import { MemoryError, memoryRoot, type MemoryEngine } from "./contract";

export type MemoryRuntimeBinding = {
  baseUrl: string;
  token: string;
  accountId: string;
  userId: string;
};
export class OpenVikingMemoryEngine implements MemoryEngine {
  constructor(
    private readonly binding: (workspaceId: string) => Promise<MemoryRuntimeBinding>,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}
  async available(workspaceId: string) {
    try {
      await Promise.all([
        this.call(workspaceId, "GET", "/ready"),
        this.call(workspaceId, "GET", "/api/v1/fs/ls", undefined, {
          uri: "viking://resources",
          limit: "1",
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }
  async write(workspaceId: string, uri: string, content: MemoryWrite) {
    this.assertUri(workspaceId, uri);
    const result = await this.call(workspaceId, "POST", "/api/v1/content/write", {
      uri,
      content: JSON.stringify(content),
      mode: "replace",
      wait: true,
      timeout: 5,
      tags: ["coforge_memory=true", `kind=${content.kind}`],
    });
    if (
      !result ||
      typeof result !== "object" ||
      !("semantic_status" in result) ||
      result.semantic_status !== "complete" ||
      !("vector_status" in result) ||
      result.vector_status !== "complete"
    )
      throw new MemoryError("unavailable");
  }
  async read(workspaceId: string, uri: string): Promise<MemoryWrite> {
    this.assertUri(workspaceId, uri);
    const value = await this.call(workspaceId, "GET", "/api/v1/content/read", undefined, {
      uri,
      raw: "true",
    });
    if (typeof value !== "string") throw new MemoryError("unavailable");
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new MemoryError("unavailable");
    }
    const command = decodePlatformMemoryCommand({
      ...(parsed as Record<string, unknown>),
      operation: "create",
      scope: "team",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    if (command.operation !== "create") throw new MemoryError("unavailable");
    return {
      title: command.title,
      content: command.content,
      kind: command.kind,
      ...(command.sourceMessageId ? { sourceMessageId: command.sourceMessageId } : {}),
      ...(command.expiresAt ? { expiresAt: command.expiresAt } : {}),
    };
  }
  async remove(workspaceId: string, uri: string) {
    this.assertUri(workspaceId, uri);
    await this.call(workspaceId, "DELETE", "/api/v1/fs", undefined, { uri, recursive: "true" });
  }
  async search(workspaceId: string, roots: string[], query: string, currentUris: string[]) {
    if (roots.length > 100 || currentUris.length > 1000) throw new MemoryError("invalid");
    if (!currentUris.length) return [];
    for (const uri of currentUris) this.assertUri(workspaceId, uri);
    for (const root of roots) this.assertUri(workspaceId, `${root}/`);
    const data = await this.call(workspaceId, "POST", "/api/v1/search/find", {
      query,
      filter: { op: "must", field: "uri", conds: currentUris },
      target_uri: roots,
      limit: 40,
      level: "2",
      tags: ["coforge_memory=true"],
    });
    if (!data || typeof data !== "object") throw new MemoryError("unavailable");
    const row = data as Record<string, unknown>;
    const hits = [row.resources, row.memories].flatMap((bucket) =>
      Array.isArray(bucket) ? bucket : [],
    );
    return hits
      .flatMap((hit) =>
        hit &&
        typeof hit === "object" &&
        "uri" in hit &&
        typeof hit.uri === "string" &&
        roots.some((root) => hit.uri.startsWith(`${root}/`))
          ? [hit.uri as string]
          : [],
      )
      .slice(0, 200);
  }
  private assertUri(workspaceId: string, uri: string) {
    const shared = uri.startsWith(`${memoryRoot(workspaceId, null)}/`);
    const privateRoot = new RegExp(
      `^viking://user/coforge-agent-[0-9a-f-]{36}/resources/coforge-${workspaceId}/`,
      "i",
    );
    if ((!shared && !privateRoot.test(uri)) || uri.includes("..") || /[%?#\\]/.test(uri))
      throw new MemoryError("forbidden");
  }
  private async call(
    workspaceId: string,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) {
    const config = await this.binding(workspaceId);
    const url = new URL(path, config.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await this.fetcher(url.href, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(7000),
      headers: {
        authorization: config.token.startsWith("Bearer ") ? config.token : `Bearer ${config.token}`,
        "x-openviking-account": config.accountId,
        "x-openviking-user": config.userId,
        "x-openviking-role": "admin",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === "DELETE" && response.status === 404) return null;
    if (!response.ok) throw new MemoryError("unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new MemoryError("unavailable");
    let size = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512000) {
          await reader.cancel();
          throw new MemoryError("unavailable");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    let envelope: { status?: string; result?: unknown };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new MemoryError("unavailable");
    }
    if (envelope.status === "error") throw new MemoryError("unavailable");
    return envelope.result ?? envelope;
  }
}
