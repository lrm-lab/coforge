import type {
  AppRateLimit,
  PeekableRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";

const GLOBAL_LOG_WINDOW_MS = 60_000;
const GLOBAL_LOGS_PER_WINDOW = 5;
const GLOBAL_KEY = "all";

export class PublicArtifactMissGuard {
  #logWindowStart = Number.NEGATIVE_INFINITY;
  #logged = 0;

  constructor(
    private readonly deps: {
      perClient: PeekableRateLimit;
      global: AppRateLimit;
      now: () => number;
    },
  ) {}

  async refusal(client: string): Promise<{ retryAfterSeconds: number } | null> {
    const decision = await this.deps.perClient.peek(client);
    return decision.allowed ? null : { retryAfterSeconds: decision.retryAfterSeconds };
  }

  async miss(client: string): Promise<void> {
    await this.deps.perClient.admit(client);
    const decision = await this.deps.global.admit(GLOBAL_KEY);
    if (!decision.allowed) this.#reportGuessing(client);
  }

  #reportGuessing(client: string) {
    const now = this.deps.now();
    if (now - this.#logWindowStart >= GLOBAL_LOG_WINDOW_MS) {
      this.#logWindowStart = now;
      this.#logged = 0;
    }
    if (this.#logged >= GLOBAL_LOGS_PER_WINDOW) return;
    this.#logged += 1;
    console.warn(JSON.stringify({ event: "artifact_link_guessing", client }));
  }
}
