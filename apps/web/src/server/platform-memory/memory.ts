import type {
  MemoryWrite,
  PlatformMemoryCommand,
  PlatformMemoryEntry,
  PlatformMemoryResult,
} from "@lrm/coforge-sdk/agent";
import {
  actorKey,
  memoryRoot,
  MemoryError,
  type MemoryActor,
  type MemoryEngine,
  type MemoryHead,
  type MemoryStore,
} from "./contract";

function hash(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}
function memoryKeys(
  scope: MemoryHead["scope"],
  agentId: string | null,
  input: MemoryWrite,
): string[] {
  return [
    hash([scope, agentId, [input.content, input.title]]),
    ...(input.sourceMessageId ? [hash([scope, agentId, input.sourceMessageId])] : []),
  ];
}
function alive(head: MemoryHead, now: Date): boolean {
  return Boolean(head.uri && !head.deletedAt && (!head.expiresAt || head.expiresAt > now));
}
function readable(head: MemoryHead, agentIds: string[]): boolean {
  return head.scope === "team" || Boolean(head.agentId && agentIds.includes(head.agentId));
}
export class PlatformMemory {
  constructor(
    private readonly store: MemoryStore,
    private readonly engine: MemoryEngine,
    private readonly now = () => new Date(),
  ) {}

  async execute(actor: MemoryActor, command: PlatformMemoryCommand): Promise<PlatformMemoryResult> {
    const access = await this.store.access(actor);
    if (command.operation === "status")
      return {
        enabled: access.enabled,
        available:
          access.enabled && (await this.engine.available(actor.workspaceId).catch(() => false)),
        entries: [],
      };
    if (!access.enabled) throw new MemoryError("disabled");
    const selected = "agentId" in command ? command.agentId : undefined;
    if (selected && !access.agentIds.includes(selected)) throw new MemoryError("forbidden");
    const agentIds = selected ? [selected] : access.agentIds;
    if (command.operation === "list") {
      const page = command.page ?? 1;
      const result = await this.store.list({
        workspaceId: actor.workspaceId,
        agentIds,
        scope: command.scope,
        page,
        now: this.now(),
      });
      return this.result(
        await Promise.all(
          result.entries.map((h) => this.entry(h, actor, access.admin, access.agentIds)),
        ),
        { page, pageCount: result.pageCount },
      );
    }
    if (command.operation === "search") {
      const roots = [
        ...(command.scope === "agent" ? [] : [memoryRoot(actor.workspaceId, null)]),
        ...(command.scope === "team"
          ? []
          : agentIds.map((id) => memoryRoot(actor.workspaceId, id))),
      ];
      if (roots.length === 0) return this.result([]);
      const candidates = await this.store.searchUris(
        actor.workspaceId,
        agentIds,
        command.scope,
        this.now(),
      );
      if (candidates.length > 1000) throw new MemoryError("unavailable");
      if (!candidates.length) return this.result([]);
      const uris = await this.engine.search(actor.workspaceId, roots, command.query, candidates);
      const heads = await this.store.current(actor.workspaceId, uris, agentIds, this.now());
      const byUri = new Map(heads.map((h) => [h.uri, h]));
      const ordered = [...new Set(uris)]
        .flatMap((uri) => {
          const h = byUri.get(uri);
          return h && (!command.scope || command.scope === h.scope) ? [h] : [];
        })
        .slice(0, 20);
      return this.result(
        await Promise.all(ordered.map((h) => this.entry(h, actor, access.admin, access.agentIds))),
      );
    }
    if (command.operation === "get")
      return this.result([
        await this.entry(
          await this.requireHead(actor, command.id, agentIds),
          actor,
          access.admin,
          access.agentIds,
        ),
      ]);
    const fingerprint = hash(command);
    const receipt = await this.store.receipt(actor.workspaceId, actorKey(actor), command.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new MemoryError("conflict");
      const h = await this.store.get(actor.workspaceId, receipt.entryId);
      if (!h || !readable(h, agentIds)) throw new MemoryError("not_found");
      if (receipt.deleted) {
        let cleanupPending = false;
        try {
          await this.engine.remove(
            actor.workspaceId,
            `${memoryRoot(actor.workspaceId, h.agentId)}/${h.id}`,
          );
        } catch {
          cleanupPending = true;
        }
        return this.result([], { deleted: true, cleanupPending });
      }
      return this.result([
        await this.entry(
          await this.requireHead(actor, h.id, agentIds),
          actor,
          access.admin,
          access.agentIds,
        ),
      ]);
    }
    if (command.operation === "create") {
      const agentId =
        command.scope === "agent"
          ? (selected ?? (actor.kind === "agent" ? actor.agentId : undefined))
          : null;
      if (command.scope === "agent" && (!agentId || !agentIds.includes(agentId)))
        throw new MemoryError("forbidden");
      await this.validateWrite(actor, command);
      const head = await this.store.reserve(
        {
          workspaceId: actor.workspaceId,
          scope: command.scope,
          agentId: agentId ?? null,
          author: actorKey(actor),
          dedupKey: memoryKeys(command.scope, agentId ?? null, command)[0]!,
          title: command.title,
          kind: command.kind,
          uri: null,
          revision: 0,
          sourceMessageId: command.sourceMessageId ?? null,
          expiresAt: command.expiresAt ? new Date(command.expiresAt) : null,
          deletedAt: null,
        },
        command.requestId,
        fingerprint,
        memoryKeys(command.scope, agentId ?? null, command),
      );
      if (head.deletedAt) throw new MemoryError("conflict");
      if (head.revision > 0) {
        if (!alive(head, this.now())) throw new MemoryError("conflict");
        if (
          !(await this.store.commit({
            head,
            expectedRevision: head.revision,
            actor: actorKey(actor),
            requestId: command.requestId,
            fingerprint,
            deleted: false,
            dedupKeys: memoryKeys(command.scope, agentId ?? null, command),
          }))
        )
          throw new MemoryError("conflict");
        return this.result([await this.entry(head, actor, access.admin, access.agentIds)]);
      }
      return this.write(actor, head, command, command.requestId, fingerprint);
    }
    const head = await this.requireHead(
      actor,
      command.id,
      agentIds,
      command.operation === "delete",
    );
    if (
      !access.admin &&
      head.author !== actorKey(actor) &&
      !(
        actor.kind === "user" &&
        (head.scope === "agent" || access.agentIds.some((id) => head.author === `agent:${id}`))
      )
    )
      throw new MemoryError("forbidden");
    if (head.revision !== command.revision) throw new MemoryError("conflict");
    if (command.operation === "share") {
      if (head.scope !== "agent") throw new MemoryError("invalid");
      const content = await this.engine.read(actor.workspaceId, head.uri!);
      const target = await this.store.reserve(
        {
          ...head,
          scope: "team",
          agentId: null,
          uri: null,
          author: actorKey(actor),
          revision: 0,
          dedupKey: hash(["share", head.id]),
        },
        command.requestId,
        fingerprint,
        [hash(["share", head.id]), ...memoryKeys("team", null, content)],
      );
      if (target.deletedAt) throw new MemoryError("conflict");
      if (target.revision > 0) throw new MemoryError("conflict");
      return this.write(actor, target, content, command.requestId, fingerprint);
    }
    if (command.operation === "delete") {
      const next = {
        ...head,
        revision: head.revision + 1,
        deletedAt: this.now(),
        updatedAt: this.now(),
      };
      if (
        !(await this.store.commit({
          head: next,
          expectedRevision: head.revision,
          actor: actorKey(actor),
          requestId: command.requestId,
          fingerprint,
          deleted: true,
          dedupKeys: [],
        }))
      )
        throw new MemoryError("conflict");
      let cleanupPending = false;
      try {
        await this.engine.remove(
          actor.workspaceId,
          `${memoryRoot(actor.workspaceId, head.agentId)}/${head.id}`,
        );
      } catch {
        cleanupPending = true;
      }
      return this.result([], { deleted: true, cleanupPending });
    }
    await this.validateWrite(actor, command);
    return this.write(actor, head, command, command.requestId, fingerprint);
  }

  private async validateWrite(actor: MemoryActor, write: MemoryWrite) {
    if (write.expiresAt && new Date(write.expiresAt) <= this.now())
      throw new MemoryError("invalid");
    if (write.sourceMessageId && !(await this.store.sourceAllowed(actor, write.sourceMessageId)))
      throw new MemoryError("forbidden");
  }
  private async requireHead(
    actor: MemoryActor,
    id: string,
    agentIds: string[],
    allowExpired = false,
  ) {
    const head = await this.store.get(actor.workspaceId, id);
    if (
      !head ||
      (!allowExpired && !alive(head, this.now())) ||
      !head.uri ||
      head.deletedAt ||
      !readable(head, agentIds)
    )
      throw new MemoryError("not_found");
    return head;
  }
  private async write(
    actor: MemoryActor,
    head: MemoryHead,
    input: MemoryWrite,
    requestId: string,
    fingerprint: string,
  ) {
    const content: MemoryWrite = {
      title: input.title,
      content: input.content,
      kind: input.kind,
      ...((input.sourceMessageId ?? head.sourceMessageId)
        ? { sourceMessageId: (input.sourceMessageId ?? head.sourceMessageId)! }
        : {}),
      ...((input.expiresAt ?? head.expiresAt?.toISOString())
        ? { expiresAt: input.expiresAt ?? head.expiresAt!.toISOString() }
        : {}),
    };
    const uri = `${memoryRoot(actor.workspaceId, head.agentId)}/${head.id}/${requestId}-${fingerprint}.json`;
    await this.engine.write(actor.workspaceId, uri, content);
    const saved = await this.engine.read(actor.workspaceId, uri);
    if (hash(saved) !== hash(content)) throw new MemoryError("unavailable");
    const next: MemoryHead = {
      ...head,
      title: content.title,
      kind: content.kind,
      dedupKey: memoryKeys(head.scope, head.agentId, content)[0]!,
      uri,
      revision: head.revision + 1,
      sourceMessageId: content.sourceMessageId ?? null,
      expiresAt: content.expiresAt ? new Date(content.expiresAt) : null,
      updatedAt: this.now(),
    };
    if (
      !(await this.store.commit({
        head: next,
        expectedRevision: head.revision,
        actor: actorKey(actor),
        requestId,
        fingerprint,
        deleted: false,
        dedupKeys: memoryKeys(head.scope, head.agentId, content),
      }))
    ) {
      const current = await this.store.get(actor.workspaceId, head.id);
      if (current?.uri !== uri) await this.engine.remove(actor.workspaceId, uri).catch(() => {});
      throw new MemoryError("conflict");
    }
    let cleanupPending = false;
    if (head.uri && head.uri !== uri) {
      try {
        await this.engine.remove(actor.workspaceId, head.uri);
      } catch {
        cleanupPending = true;
      }
    }
    return this.result([this.project(next, saved)], { cleanupPending });
  }
  private async entry(
    head: MemoryHead,
    actor?: MemoryActor,
    admin = false,
    ownedAgentIds: string[] = [],
  ): Promise<PlatformMemoryEntry> {
    const entry = this.project(head, await this.engine.read(head.workspaceId, head.uri!));
    return {
      ...entry,
      canEdit: Boolean(
        admin ||
        (actor &&
          (head.author === actorKey(actor) ||
            (actor.kind === "user" &&
              (head.scope === "agent" ||
                ownedAgentIds.some((id) => head.author === `agent:${id}`))))),
      ),
    };
  }
  private project(head: MemoryHead, content: MemoryWrite): PlatformMemoryEntry {
    return {
      ...content,
      id: head.id,
      title: head.title,
      kind: head.kind,
      scope: head.scope,
      agentId: head.agentId,
      revision: head.revision,
      createdAt: head.createdAt.toISOString(),
      updatedAt: head.updatedAt.toISOString(),
    };
  }
  private result(
    entries: PlatformMemoryEntry[],
    extra: Partial<PlatformMemoryResult> = {},
  ): PlatformMemoryResult {
    return { enabled: true, available: true, entries, ...extra };
  }
}
