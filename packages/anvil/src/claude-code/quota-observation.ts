import { asRecord } from "#src/json-record";
import { claudeQuotaResetTime } from "./rate-limit";

const quotaWindows = [
  "five_hour",
  "seven_day",
  "seven_day_fable",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
] as const;

type QuotaWindow = (typeof quotaWindows)[number] | "unknown";
type QuotaStatus = "allowed" | "allowed_warning" | "rejected";
type QuotaFact =
  | {
      type: "quota_window";
      window: QuotaWindow;
      status: QuotaStatus;
      resetsAt: string | null;
    }
  | { type: "rate_limit_error"; afterWindowRejection: boolean };

export type ClaudeQuotaObservation = QuotaFact & { observedAt: string };

export class ClaudeQuotaObserver {
  readonly #lastWindow = new Map<QuotaWindow, { status: QuotaStatus; resetsAt: string | null }>();
  #sessionId: string | undefined;
  #lastStatus: QuotaStatus | undefined;

  constructor(private readonly observe: (observation: ClaudeQuotaObservation) => void) {}

  accept(record: Readonly<Record<string, unknown>>, sessionId: string | undefined): void {
    if (!sessionId || record.session_id !== sessionId || record.agent_id != null) return;
    if (record.type !== "rate_limit_event" && record.type !== "assistant") return;
    if (this.#sessionId !== sessionId) {
      this.#sessionId = sessionId;
      this.#lastWindow.clear();
      this.#lastStatus = undefined;
    }
    if (record.type === "rate_limit_event") this.#observeWindow(record.rate_limit_info);
    else if (record.error === "rate_limit")
      this.#record({
        type: "rate_limit_error",
        afterWindowRejection: this.#lastStatus === "rejected",
      });
  }

  #observeWindow(raw: unknown): void {
    const info = asRecord(raw);
    if (!info) return;
    const status = info.status;
    if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return;
    const window = quotaWindows.find((value) => value === info.rateLimitType) ?? "unknown";
    const resetsAt = claudeQuotaResetTime(info.resetsAt)?.toISOString() ?? null;
    const previous = this.#lastWindow.get(window);
    this.#lastStatus = status;
    if (previous?.status === status && previous.resetsAt === resetsAt) return;
    if (this.#record({ type: "quota_window", status, window, resetsAt }))
      this.#lastWindow.set(window, { status, resetsAt });
  }

  #record(fact: QuotaFact): boolean {
    try {
      this.observe({ ...fact, observedAt: new Date().toISOString() });
      return true;
    } catch {
      return false;
    }
  }
}
