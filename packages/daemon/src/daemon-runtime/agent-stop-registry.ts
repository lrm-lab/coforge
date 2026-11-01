import type { SessionReference } from "./launch-identity";

/**
 * One Workspace runtime's record of which Agents are stopping and which Session each running
 * Agent last reported.
 *
 * The record has one owner so "this Agent is stopping" cannot be written from everywhere that
 * happens to hold a collection: readers ask `isStopping`/`pendingStop`/`sessionReference`, and a
 * write happens only where a stop begins, where it settles, or where a launch reports its Session.
 */
export class AgentStopRegistry {
  readonly #stopping = new Set<string>();
  readonly #stops = new Map<string, Promise<void>>();
  readonly #sessions = new Map<string, SessionReference>();

  /** Whether this Agent is stopping: its stop began, or one is still in flight. */
  isStopping(agentId: string): boolean {
    return this.#stopping.has(agentId) || this.#stops.has(agentId);
  }

  /** Whether this Agent's stop began and has not settled. */
  stopping(agentId: string): boolean {
    return this.#stopping.has(agentId);
  }

  /** The stop still in flight for this Agent, if any. */
  pendingStop(agentId: string): Promise<void> | undefined {
    return this.#stops.get(agentId);
  }

  /** The Session this Agent's running launch last reported, if any. */
  sessionReference(agentId: string): SessionReference | undefined {
    return this.#sessions.get(agentId);
  }

  /** The native Session id that launch reported, if any. */
  sessionId(agentId: string): string | undefined {
    return this.#sessions.get(agentId)?.sessionId;
  }

  /** Every Agent whose stop began and has not settled. */
  stoppingAgentIds(): readonly string[] {
    return [...this.#stopping];
  }

  /**
   * Begins a stop: the Agent stops admitting launches and forgets the Session its previous launch
   * reported, before the first await of the stop itself.
   */
  beginStop(agentId: string): void {
    this.#stopping.add(agentId);
    this.#sessions.delete(agentId);
  }

  /** Registers the stop now in flight, so a second caller joins it instead of starting one. */
  trackStop(agentId: string, stop: Promise<void>): void {
    this.#stops.set(agentId, stop);
  }

  /**
   * Settles a stop. `processStopping` keeps the Agent marked stopping while its process tree is
   * still being torn down, so a launch cannot race the cleanup it would replace.
   */
  settleStop(agentId: string, processStopping: boolean): void {
    this.#stops.delete(agentId);
    if (!processStopping) this.#stopping.delete(agentId);
  }

  /** Forgets a settled stop's mark without touching the Session record. */
  forgetStopping(agentId: string): void {
    this.#stopping.delete(agentId);
  }

  /** Records the Session a launch reported. */
  rememberSession(agentId: string, reference: SessionReference): void {
    this.#sessions.set(agentId, reference);
  }

  /** Forgets an Agent's Session record, as a replaced or ended launch does. */
  forgetSession(agentId: string): void {
    this.#sessions.delete(agentId);
  }

  /** Marks every named Agent stopping, as a whole-runtime stop does. */
  beginAll(agentIds: Iterable<string>): void {
    for (const agentId of agentIds) this.#stopping.add(agentId);
  }

  /** Clears every mark and record, as a whole-runtime stop does once its Agents are down. */
  clear(): void {
    this.#stopping.clear();
    this.#stops.clear();
    this.#sessions.clear();
  }
}
