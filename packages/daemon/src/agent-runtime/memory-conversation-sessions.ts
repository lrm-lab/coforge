import type {
  AgentConversationScope,
  AgentNoticeOptions,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { AgentSessionRecoveryError } from "#src/code-agent/contract";
import { memoryConversationInstructions } from "#src/code-agent/agent-instructions";

export interface ConversationSessionStore {
  get(controlSessionId: string, conversationId: string): Promise<AgentSessionIdentity | undefined>;
  set(
    controlSessionId: string,
    conversationId: string,
    identity: AgentSessionIdentity,
  ): Promise<void>;
}

type Dependencies = {
  primary: AgentSession;
  options: AgentSessionOptions;
  create(options: AgentSessionOptions): Promise<AgentSession>;
  store?: ConversationSessionStore;
};
type Conversation = {
  scope: { conversationId: string; target: string };
  cancelled: Promise<never>;
  cancel(error: Error): void;
  closed: boolean;
  creating?: Promise<AgentSession>;
  session?: AgentSession;
};
type PendingNotice = {
  session: AgentSession;
  conversation?: Conversation;
  send(): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

/** One identity and shared working directory, independent native histories per conversation.
 * Groups take turns using the directory; notices for the current group may steer its live turn.
 * The primary remains the cloud lifecycle identity and has no conversational tools. */
export class MemoryConversationSessions implements AgentSession {
  readonly #conversations = new Map<string, Conversation>();
  readonly #children = new Set<AgentSession>();
  readonly #creating = new Set<Promise<AgentSession>>();
  readonly #writes = new Set<Promise<void>>();
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exits = new Set<() => void>();
  readonly #waiting: PendingNotice[] = [];
  #active?: AgentSession;
  #admitting = 0;
  #closed = false;
  #stopping = false;
  #disposal?: Promise<void>;
  readonly #unsubscribe: () => void;
  readonly #stopSignal: Promise<never>;
  #rejectStop!: (error: Error) => void;

  constructor(private readonly dependencies: Dependencies) {
    this.#stopSignal = new Promise<never>((_, reject) => {
      this.#rejectStop = reject;
    });
    void this.#stopSignal.catch(() => {});
    if (dependencies.primary.hasLiveTurn === true) this.#active = dependencies.primary;
    this.#unsubscribe = dependencies.primary.subscribe((event) =>
      this.#observe(dependencies.primary, event),
    );
    dependencies.primary.onExit(() => {
      if (!this.#closed) void this.dispose().catch(() => {});
    });
  }

  get hasLiveTurn(): boolean | undefined {
    if (this.#active || this.#waiting.length || this.#admitting) return true;
    return this.dependencies.primary.hasLiveTurn;
  }

  hasLiveTurnForConversation(conversationId: string): boolean | undefined {
    const session = this.#conversations.get(conversationId)?.session;
    return session ? this.#active === session || session.hasLiveTurn : false;
  }

  readSessionIdentity(): Promise<AgentSessionIdentity | undefined> {
    return this.dependencies.primary.readSessionIdentity?.() ?? Promise.resolve(undefined);
  }

  sendMessage(message: string): Promise<void> {
    return this.#admit(this.dependencies.primary, () =>
      this.dependencies.primary.sendMessage(message),
    );
  }

  async notify(message: string, options?: AgentNoticeOptions): Promise<void> {
    if (this.#stopping) throw new Error("Memory Agent is stopping");
    const scope = options?.conversation;
    const conversation = scope ? this.#conversation(scope) : undefined;
    const session = conversation
      ? await Promise.race([conversation.creating!, conversation.cancelled, this.#stopSignal])
      : this.dependencies.primary;
    if (conversation && scope) conversation.scope.target = scope.target;
    await this.#admit(
      session,
      () => (session.notify ? session.notify(message, options) : session.sendMessage(message)),
      conversation,
    );
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  async interrupt(): Promise<void> {
    await this.#active?.interrupt();
  }

  /** Synchronous cancellation unblocks Runtime's input drain before Stop awaits disposal. */
  cancelPendingNotices(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    const error = new Error("Memory Agent is stopping");
    this.#rejectStop(error);
    for (const notice of this.#waiting.splice(0)) notice.reject(error);
  }

  async purgeConversation(conversationId: string): Promise<void> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) return;
    conversation.closed = true;
    conversation.cancel(new Error("Memory conversation was purged"));
    this.#conversations.delete(conversationId);
    for (let index = this.#waiting.length - 1; index >= 0; index--) {
      if (this.#waiting[index]!.conversation !== conversation) continue;
      this.#waiting.splice(index, 1)[0]!.reject(new Error("Memory conversation was purged"));
    }
    await conversation.creating?.catch(() => {});
    const session = conversation.session;
    if (session) {
      await session.dispose();
      this.#children.delete(session);
      if (this.#active === session) this.#active = undefined;
    }
    this.#drain();
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.cancelPendingNotices();
    this.#closed = true;
    this.#unsubscribe();
    this.#disposal = this.#dispose().catch((error) => {
      this.#disposal = undefined;
      throw error;
    });
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    await Promise.allSettled(this.#creating);
    const sessions = [this.dependencies.primary, ...this.#children];
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        await session.dispose();
      }),
    );
    await Promise.allSettled(this.#writes);
    results.forEach((result, index) => {
      if (result.status === "fulfilled") this.#children.delete(sessions[index]!);
    });
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Memory Agent session cleanup failed");
    this.#conversations.clear();
    this.#listeners.clear();
    for (const exit of this.#exits) exit();
    this.#exits.clear();
  }

  #conversation(scope: AgentConversationScope): Conversation {
    const existing = this.#conversations.get(scope.conversationId);
    if (existing?.creating) return existing;
    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = reject;
    });
    void cancelled.catch(() => {});
    const conversation: Conversation = { scope: { ...scope }, cancelled, cancel, closed: false };
    const creating = this.#create(conversation);
    conversation.creating = creating;
    this.#conversations.set(scope.conversationId, conversation);
    this.#creating.add(creating);
    void creating.then(
      () => this.#creating.delete(creating),
      () => {
        this.#creating.delete(creating);
        if (this.#conversations.get(scope.conversationId) === conversation)
          this.#conversations.delete(scope.conversationId);
      },
    );
    return conversation;
  }

  async #create(conversation: Conversation): Promise<AgentSession> {
    const { options, store, create } = this.dependencies;
    const { scope } = conversation;
    const controlId = (await this.readSessionIdentity())?.sessionId ?? options.sessionId;
    if (!controlId) throw new Error("Memory Agent control session identity is not available");
    const stored = await store?.get(controlId, scope.conversationId);
    this.#assertAdmission(conversation);
    const persist = (identity: AgentSessionIdentity): Promise<void> => {
      const write = store?.set(controlId, scope.conversationId, identity) ?? Promise.resolve();
      this.#writes.add(write);
      void write.then(
        () => this.#writes.delete(write),
        () => this.#writes.delete(write),
      );
      return write;
    };
    const open = (sessionId: string, sessionMode: "create" | "resume") =>
      create({
        ...options,
        conversation: scope,
        environment: {
          ...options.environment,
          COFORGE_AGENT_CONVERSATION_TARGET: scope.target.split(":")[0]!,
        },
        memoryControlSession: false,
        sessionId,
        sessionMode,
        instructions: memoryConversationInstructions(options.instructions, scope),
        onSessionId: async (nativeId) => {
          await persist({ sessionId: nativeId, state: "unknown" });
        },
      });
    let child: AgentSession;
    try {
      child = await open(stored?.sessionId ?? crypto.randomUUID(), stored ? "resume" : "create");
    } catch (error) {
      if (
        !stored ||
        !(error instanceof AgentSessionRecoveryError) ||
        error.code === "session_in_use"
      )
        throw error;
      this.#assertAdmission(conversation);
      child = await open(crypto.randomUUID(), "create");
    }
    this.#children.add(child);
    conversation.session = child;
    child.subscribe((event) => {
      if (this.#closed || conversation.closed) return;
      if (event.type === "session") void persist(event.identity).catch(() => {});
      this.#observe(child, { ...event, conversation: { ...scope } });
    });
    child.onExit(() => {
      if (!this.#children.delete(child)) return;
      if (this.#conversations.get(scope.conversationId) === conversation)
        this.#conversations.delete(scope.conversationId);
      if (!this.#closed && this.#active === child)
        this.#observe(child, { type: "completed", status: "failed", conversation: { ...scope } });
    });
    if (this.#stopping || conversation.closed) {
      await child.dispose();
      this.#assertAdmission(conversation);
    }
    try {
      const identity = await child.readSessionIdentity?.();
      if (identity) await persist(identity);
      this.#assertAdmission(conversation);
      return child;
    } catch (error) {
      await child.dispose();
      throw error;
    }
  }

  #assertAdmission(conversation?: Conversation): void {
    if (this.#stopping) throw new Error("Memory Agent is stopping");
    if (conversation?.closed) throw new Error("Memory conversation was purged");
  }

  #observe(session: AgentSession, event: AgentRuntimeEvent): void {
    if (this.#closed) return;
    if (event.type === "completed" && this.#active === session) this.#active = undefined;
    for (const listener of this.#listeners) listener(event);
    if (event.type === "completed") queueMicrotask(() => this.#drain());
  }

  #admit(
    session: AgentSession,
    send: () => Promise<void>,
    conversation?: Conversation,
  ): Promise<void> {
    try {
      this.#assertAdmission(conversation);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#active && this.#active !== session)
      return new Promise((resolve, reject) => {
        this.#waiting.push({ session, conversation, send, resolve, reject });
      });
    this.#active = session;
    this.#admitting++;
    return send()
      .catch((error) => {
        if (this.#active === session && session.hasLiveTurn !== true) this.#active = undefined;
        throw error;
      })
      .finally(() => {
        this.#admitting--;
        if (!this.#admitting && session.hasLiveTurn === false && this.#active === session)
          this.#active = undefined;
        this.#drain();
      });
  }

  #drain(): void {
    if (this.#stopping || this.#active || this.#admitting) return;
    const next = this.#waiting.shift();
    if (next)
      void this.#admit(next.session, next.send, next.conversation).then(next.resolve, next.reject);
  }
}
