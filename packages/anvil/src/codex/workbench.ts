import type { PiChatRuntime, WorkbenchCodex, WorkbenchTranscriptPage } from "@coforge/agent";
import {
  asRecord,
  JsonlRequestError,
  withDeadline,
  type ProcessTreeSpawner,
} from "@lrm/coforge-anvil";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import type {
  PiChatMessage,
  PiChatUpdate,
  WorkbenchApproval,
} from "@lrm/coforge-sdk/internal/pi-chat";

type Record = Readonly<{ [key: string]: unknown }>;
type Process = Pick<
  JsonlProcess,
  "request" | "send" | "onRecord" | "onFailure" | "onClose" | "dispose"
>;
type PendingApproval = {
  requestId: string | number;
  approval: WorkbenchApproval;
  timer: ReturnType<typeof setTimeout>;
};
const deadline = (message: string) => new Error(`Codex ${message} timed out`);
const boundedText = (value: unknown, length = 100_000) =>
  typeof value === "string" ? value.slice(0, length) : "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function message(value: unknown, turnId: unknown): PiChatMessage | undefined {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || typeof turnId !== "string") return;
  const id = `${turnId}:${item.id}`;
  switch (item.type) {
    case "userMessage":
      return {
        id,
        role: "user",
        text: boundedText(
          list(item.content)
            .map((part) => boundedText(asRecord(part)?.text))
            .join("\n"),
        ),
      };
    case "agentMessage":
      return { id, role: "assistant", text: boundedText(item.text) };
    case "commandExecution":
      return {
        id,
        role: "tool",
        toolName: "Command",
        text: boundedText(item.aggregatedOutput),
        details: boundedText(item.command),
        isError:
          item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0),
      };
    case "fileChange":
      return {
        id,
        role: "tool",
        toolName: "File changes",
        text: boundedText(
          list(item.changes)
            .map((change) => boundedText(asRecord(change)?.path))
            .join("\n"),
        ),
        isError: item.status === "failed",
      };
  }
}

export function codexWorkbench(
  directory: () => Promise<string>,
  options: {
    command: () => readonly string[];
    environment: Readonly<{ [key: string]: string }>;
    spawner: ProcessTreeSpawner;
    notify: (event: PiChatUpdate) => void;
  },
): WorkbenchCodex {
  async function connect() {
    const cwd = await directory();
    const process = new JsonlProcess(options.command(), cwd, options.environment, options.spawner);
    try {
      await request(process, "initialize", {
        clientInfo: { name: "coforge_workbench", title: "CoForge Workbench", version: "1.0.0" },
      });
      await process.send({ method: "initialized" });
      return { process, cwd };
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
  return {
    async open(id) {
      const { process, cwd } = await connect();
      try {
        const result = await request(process, id ? "thread/resume" : "thread/start", {
          ...(id ? { threadId: id, excludeTurns: true } : { ephemeral: false }),
          cwd,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          config: {
            "sandbox_workspace_write.network_access": false,
            "sandbox_workspace_write.exclude_tmpdir_env_var": true,
            "sandbox_workspace_write.exclude_slash_tmp": true,
          },
        });
        const thread = asRecord(result.thread);
        const threadId = thread?.id;
        const sandbox = asRecord(result.sandbox);
        if (
          typeof threadId !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId) ||
          (id && threadId !== id) ||
          sandbox?.type !== "workspaceWrite" ||
          sandbox.networkAccess !== false ||
          sandbox.excludeTmpdirEnvVar !== true ||
          sandbox.excludeSlashTmp !== true ||
          !Array.isArray(sandbox.writableRoots) ||
          list(sandbox.writableRoots).length ||
          result.approvalPolicy !== "on-request"
        )
          throw new Error("Codex did not open the requested workspace session");
        return new CodexWorkbenchSession(
          process,
          threadId,
          boundedText(result.model, 200) || "Codex",
          [],
          options.notify,
          !id,
        );
      } catch (error) {
        await process.dispose();
        throw error;
      }
    },
    async history(id, cursor) {
      const { process } = await connect();
      try {
        return await nativePage(process, id, cursor);
      } finally {
        await process.dispose();
      }
    },
    async archive(id) {
      const { process } = await connect();
      try {
        await request(process, "thread/archive", { threadId: id });
      } catch (error) {
        const native =
          error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
        if (!isUnmaterializedThread(native, id)) throw error;
      } finally {
        await process.dispose();
      }
    },
  };
}

async function request(process: Process, method: string, params: Record) {
  const reply = await withDeadline(process.request({ method, params }), 10_000, () =>
    deadline(method),
  );
  return asRecord(reply.result) ?? {};
}

async function nativePage(
  process: Process,
  id: string,
  cursor?: string,
  fresh = false,
): Promise<WorkbenchTranscriptPage> {
  try {
    const result = await request(process, "thread/items/list", {
      threadId: id,
      sortDirection: "desc",
      limit: 32,
      ...(cursor ? { cursor } : {}),
    });
    return {
      messages: list(result.data)
        .slice(0, 32)
        .reverse()
        .flatMap((entry) => {
          const item = asRecord(entry);
          const row = message(item?.item, item?.turnId);
          return row ? [row] : [];
        }),
      ...(typeof result.nextCursor === "string" &&
      result.nextCursor &&
      result.nextCursor.length <= 4096
        ? { cursor: result.nextCursor }
        : {}),
    };
  } catch (error) {
    const native = error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
    if (isUnmaterializedThread(native, id)) return { messages: [] };
    if (native?.code === -32601 && native.message === "thread/items/list is not supported yet") {
      try {
        await request(process, "thread/read", { threadId: id, includeTurns: false });
      } catch (readError) {
        const read =
          readError instanceof JsonlRequestError ? asRecord(readError.responseError) : undefined;
        if (isUnmaterializedThread(read, id)) return { messages: [] };
        throw readError;
      }
      if (fresh && !cursor) return { messages: [] };
    }
    throw error;
  }
}

function isUnmaterializedThread(error: Record | undefined, id: string) {
  return (
    error?.code === -32600 &&
    (error.message === `thread not loaded: ${id}` ||
      error.message === `no rollout found for thread id ${id}`)
  );
}

export class CodexWorkbenchSession implements PiChatRuntime {
  readonly #messages: Map<string, PiChatMessage>;
  readonly #approvals = new Map<string, PendingApproval>();
  readonly #fileChanges = new Map<string, string>();
  #turn?: ReturnType<typeof Promise.withResolvers<void>>;
  #turnId?: string;
  #stopping = false;

  constructor(
    private readonly process: Process,
    readonly id: string,
    private readonly modelId: string,
    messages: PiChatMessage[],
    private readonly notify: (update: PiChatUpdate) => void,
    private readonly fresh = false,
  ) {
    this.#messages = new Map(messages.map((row) => [row.id, row]));
    process.onRecord((record) => this.#accept(record));
    process.onFailure((error) => this.#turn?.reject(error));
    process.onClose(() => this.#turn?.reject(new Error("Codex stopped before finishing")));
  }

  model() {
    return this.modelId;
  }
  messages() {
    return [...this.#messages.values()];
  }
  async nativePage(cursor?: string) {
    const page = await nativePage(this.process, this.id, cursor, this.fresh);
    if (cursor) return page;
    const live = this.messages();
    if (!page.messages.length) return { ...page, messages: live };
    const ids = new Set(page.messages.map((row) => row.id));
    const overlap = live.findLastIndex((row) => ids.has(row.id));
    const committed = page.messages.map((row) => this.#messages.get(row.id) ?? row);
    const newer =
      overlap >= 0
        ? live.slice(overlap + 1)
        : this.#turnId && !page.messages.some((row) => row.id.startsWith(`${this.#turnId}:`))
          ? live
          : [];
    return { ...page, messages: [...committed, ...newer] };
  }
  approvals() {
    return [...this.#approvals.values()].map(({ approval }) => approval);
  }

  async prompt(text: string) {
    if (this.#turn || this.#stopping) throw new Error("Codex session is busy");
    const turn = Promise.withResolvers<void>();
    this.#turn = turn;
    void turn.promise.catch(() => {});
    try {
      const result = await request(this.process, "turn/start", {
        threadId: this.id,
        input: [{ type: "text", text, text_elements: [] }],
      });
      const id = asRecord(result.turn)?.id;
      if (typeof id !== "string") throw new Error("Codex did not start a turn");
      this.#turnId = id;
      await turn.promise;
    } finally {
      this.#turn = undefined;
      this.#turnId = undefined;
      this.#clearApprovals();
    }
  }

  async resume(): Promise<void> {
    throw new Error("Inspect the interrupted Codex turn before continuing");
  }

  async abort() {
    this.#stopping = true;
    try {
      if (this.#turnId) {
        await withDeadline(
          this.process.request({
            method: "turn/interrupt",
            params: { threadId: this.id, turnId: this.#turnId },
          }),
          2500,
          () => deadline("interrupt"),
        ).catch(() => {});
      }
    } finally {
      this.#turn?.reject(new Error("Codex interrupted"));
      await this.dispose();
    }
  }

  async dispose() {
    this.#clearApprovals();
    await this.process.dispose();
  }

  async decide(id: string, decision: "allow" | "deny") {
    const pending = this.#approvals.get(id);
    if (!pending || this.#stopping || !this.#turn) throw new Error("approval is no longer pending");
    this.#approvals.delete(id);
    clearTimeout(pending.timer);
    this.#publishApprovals();
    await this.process.send({
      id: pending.requestId,
      result: { decision: decision === "allow" ? "accept" : "decline" },
    });
  }

  #publishApprovals() {
    this.notify({ sessionId: this.id, approvals: this.approvals() });
  }

  #clearApprovals() {
    if (!this.#approvals.size) return;
    for (const pending of this.#approvals.values()) clearTimeout(pending.timer);
    this.#approvals.clear();
    this.#publishApprovals();
  }

  #accept(record: Record) {
    const { method, id } = record;
    const params = asRecord(record.params);
    if (typeof method !== "string" || record.result !== undefined || record.error !== undefined)
      return;
    if (typeof id === "number" || typeof id === "string") {
      this.#acceptApproval(id, method, params);
      return;
    }
    if (params?.threadId !== this.id || !this.#turn || this.#stopping) return;
    if (method === "turn/started") {
      const turnId = asRecord(params.turn)?.id;
      if (typeof turnId === "string") this.#turnId ??= turnId;
    }
    if (typeof params.turnId === "string" && this.#turnId && params.turnId !== this.#turnId) return;
    if (
      method === "item/agentMessage/delta" &&
      typeof params.itemId === "string" &&
      typeof params.turnId === "string"
    ) {
      const messageId = `${params.turnId}:${params.itemId}`;
      const prior = this.#messages.get(messageId);
      this.#upsert({
        id: messageId,
        role: "assistant",
        text: boundedText((prior?.text ?? "") + boundedText(params.delta)),
      });
    }
    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      if (item?.type === "fileChange" && typeof item.id === "string") {
        if (method === "item/started") {
          const changes = list(item.changes).map(asRecord);
          if (
            changes.length &&
            changes.every(
              (change) =>
                typeof change?.path === "string" &&
                typeof change.diff === "string" &&
                change.diff.trim().length > 0,
            )
          ) {
            const detail = changes.map((change) => `${change!.path}\n${change!.diff}`).join("\n");
            if (detail.length <= 4000 && this.#fileChanges.size < 20)
              this.#fileChanges.set(item.id, detail);
          }
        } else {
          this.#fileChanges.delete(item.id);
        }
      }
      const row = message(params.item, params.turnId);
      if (row) this.#upsert(row);
    }
    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (this.#turnId && turn?.id !== this.#turnId) return;
      for (const item of list(turn?.items)) {
        const row = message(item, turn?.id);
        if (row) this.#upsert(row);
      }
      if (turn?.status === "completed") this.#turn.resolve();
      else this.#turn.reject(new Error("Codex turn did not complete"));
    }
  }

  #upsert(row: PiChatMessage) {
    this.#messages.set(row.id, row);
    if (this.#messages.size > 100) this.#messages.delete(this.#messages.keys().next().value!);
    this.notify({ sessionId: this.id, messages: [row] });
  }

  #acceptApproval(requestId: string | number, method: string, params: Record | undefined) {
    const kind =
      method === "item/commandExecution/requestApproval"
        ? "command"
        : method === "item/fileChange/requestApproval"
          ? "file-change"
          : undefined;
    const matchesTurn =
      params?.threadId === this.id && (!this.#turnId || params.turnId === this.#turnId);
    if (!kind || !matchesTurn || !this.#turn || this.#stopping) {
      void this.process
        .send({ id: requestId, error: { code: -32601, message: "Approval unavailable" } })
        .catch(() => {});
      return;
    }
    if ([...this.#approvals.values()].some((pending) => pending.requestId === requestId)) return;
    const item =
      typeof params.itemId === "string" ? this.#fileChanges.get(params.itemId) : undefined;
    const requested = kind === "command" ? params.command : item;
    const location = kind === "command" ? params.cwd : params.grantRoot;
    const detail =
      typeof requested === "string" && requested
        ? [requested, location, params.reason]
            .filter((value): value is string => typeof value === "string" && !!value)
            .join("\n")
        : "";
    if (
      !detail ||
      detail.length > 4000 ||
      this.#approvals.size >= 20 ||
      (kind === "file-change" && params.grantRoot)
    ) {
      void this.process.send({ id: requestId, result: { decision: "decline" } }).catch(() => {});
      return;
    }
    const id = crypto.randomUUID();
    this.#approvals.set(id, {
      approval: { id, kind, detail },
      requestId,
      timer: setTimeout(() => void this.decide(id, "deny").catch(() => {}), 120_000),
    });
    this.#publishApprovals();
  }
}
