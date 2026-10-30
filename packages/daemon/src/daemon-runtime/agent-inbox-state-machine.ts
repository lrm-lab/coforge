import {
  AgentContinuationStore,
  type AgentContinuation,
  type AgentContinuationAnswer,
  type AgentContinuationLookup,
} from "#src/persistence/agent-continuation-store";
import type { AgentStateDb } from "#src/persistence/agent-state-db";
import {
  AgentMessageDraftStore,
  type AgentMessageDraftContent,
  type AgentMessageDraftLookup,
} from "#src/persistence/agent-message-draft-store";

/** The draft while it is only in memory: the stored entry minus the file-only
 * `target`/`savedAt`. */
type InMemoryDraft = AgentMessageDraftContent & { reholdCount: number };

/** What `--send-draft` found for a target: the store's lookup, whose found draft may also be one
 * that lives only in memory. */
export type AgentInboxDraftLookup =
  | Exclude<AgentMessageDraftLookup, { status: "found" }>
  | { status: "found"; draft: InMemoryDraft };

/**
 * Draft continuation state: `content`, `attachmentIds`, `idempotencyKey`, `mentions`,
 * `reholdCount`, `seenUpToSeq`. The daemon owns the draft (the CLI is a thin client), so this is
 * the one place a held send is remembered between requests.
 */
export class AgentInboxStateMachine {
  readonly #drafts = new Map<string, InMemoryDraft>();
  readonly #continuations = new Map<
    string,
    { continuation: AgentContinuation; answer?: AgentContinuationAnswer }
  >();

  constructor(
    private readonly persistence?: AgentMessageDraftStore,
    private readonly continuations?: AgentContinuationStore,
  ) {}

  /** The fully persisted inbox: drafts and continuations share the Agent's one state database. */
  static open(stateDb: AgentStateDb): AgentInboxStateMachine {
    return new AgentInboxStateMachine(
      new AgentMessageDraftStore(stateDb),
      new AgentContinuationStore(stateDb),
    );
  }

  async save(target: string, draft: AgentMessageDraftContent) {
    this.#drafts.set(target, { ...draft, reholdCount: 0 });
    await this.persistence?.save(target, draft);
  }

  async replace(target: string, draft: AgentMessageDraftContent & { reholdCount: number }) {
    this.#drafts.set(target, draft);
    await this.persistence?.replace(target, draft);
  }

  async draft(target: string): Promise<InMemoryDraft | undefined> {
    const lookup = await this.lookup(target);
    return lookup.status === "found" ? lookup.draft : undefined;
  }

  async lookup(target: string): Promise<AgentInboxDraftLookup> {
    if (this.persistence) return this.persistence.lookup(target);
    const draft = this.#drafts.get(target);
    return draft ? { status: "found", draft } : { status: "missing" };
  }

  /** Clears the draft only when it still belongs to the send with this key. */
  async clearIfIdempotencyKeyMatches(target: string, idempotencyKey: string): Promise<boolean> {
    if (this.persistence) {
      const cleared = await this.persistence.clearIfIdempotencyKeyMatches(target, idempotencyKey);
      if (cleared) this.#drafts.delete(target);
      return cleared;
    }
    if (this.#drafts.get(target)?.idempotencyKey !== idempotencyKey) return false;
    this.#drafts.delete(target);
    return true;
  }

  async clear(target: string) {
    this.#drafts.delete(target);
    await this.persistence?.clear(target);
  }

  /** A held send's fresh continuation; a new one supersedes its target's still-open ones. */
  async saveContinuation(continuation: AgentContinuation, now: number): Promise<void> {
    if (this.continuations) return this.continuations.create(continuation);
    for (const [id, entry] of this.#continuations)
      if (entry.continuation.target === continuation.target && !entry.answer)
        this.#continuations.delete(id);
    for (const [id, entry] of this.#continuations)
      if (entry.continuation.expiresAt <= now) this.#continuations.delete(id);
    this.#continuations.set(continuation.id, { continuation });
  }

  async continuation(id: string, now: number): Promise<AgentContinuationLookup> {
    if (this.continuations) return this.continuations.lookup(id);
    const entry = this.#continuations.get(id);
    if (!entry) return { status: "missing" };
    if (entry.answer)
      return { status: "answered", continuation: entry.continuation, answer: entry.answer };
    if (entry.continuation.expiresAt <= now) {
      this.#continuations.delete(id);
      return { status: "expired", continuation: entry.continuation };
    }
    return { status: "open", continuation: entry.continuation };
  }

  /** Records the answer atomically: returns false when it was already answered (or gone). */
  async answerContinuation(id: string, answer: AgentContinuationAnswer): Promise<boolean> {
    if (this.continuations) return this.continuations.markAnswered(id, answer);
    const entry = this.#continuations.get(id);
    if (!entry || entry.answer) return false;
    entry.answer = answer;
    return true;
  }
}
