import type { RuntimeModelWindow, RuntimeModelWindowAvailable } from "@coforge/agent";
import { RUNTIME_PROVIDER, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  isClaudeQuotaAccountDigest,
  type ClaudeModelQuotaLedger,
} from "#src/persistence/claude-model-quota-ledger";

export type ClaudeModelQuotaLaunch = {
  provider?: string;
  model?: string;
  modelQuotaInputHeld?: true;
  resumeModelQuotaInput?: (held: readonly AgentMessageDelivery[]) => void;
};
type Model = RuntimeModelWindow["model"];
type Binding = {
  launch: ClaudeModelQuotaLaunch;
  accountDigest: string;
  model: Model;
  untilMs?: number;
  timer?: ReturnType<typeof setTimeout>;
};

export function claudeQuotaModel(model: string | undefined): Model | undefined {
  const family =
    model?.match(/^claude-(fable|opus|sonnet)-[0-9]+(?:-[0-9]+)*(?:\[1m\])?$/)?.[1] ?? model;
  if (family === "fable" || family === "opus" || family === "sonnet") return family;
}

export class ClaudeModelQuotaHolds {
  readonly #bindings = new Map<string, Binding>();

  constructor(
    private readonly ledger: () => ClaudeModelQuotaLedger,
    private readonly project: (agentId: string, held: boolean) => void,
  ) {}

  bind(agentId: string, launch: ClaudeModelQuotaLaunch, accountDigest: string | undefined): void {
    const model =
      launch.provider === RUNTIME_PROVIDER.CLAUDE_CODE ? claudeQuotaModel(launch.model) : undefined;
    if (this.#bindings.get(agentId)?.launch === launch) return;
    this.unbind(agentId);
    if (!model || !isClaudeQuotaAccountDigest(accountDigest)) return;
    const binding: Binding = { launch, accountDigest, model };
    this.#bindings.set(agentId, binding);
    this.#refresh(agentId, binding);
  }

  launchFor(agentId: string): ClaudeModelQuotaLaunch | undefined {
    return this.#bindings.get(agentId)?.launch;
  }

  holding(agentId: string): boolean {
    return this.#bindings.get(agentId)?.untilMs !== undefined;
  }

  noteRejected(
    agentId: string,
    launch: ClaudeModelQuotaLaunch,
    window: RuntimeModelWindow,
    untilMs: number,
    now: number,
  ): boolean {
    const binding = this.#matchingBinding(agentId, launch, window);
    if (!binding) return false;
    if (
      this.ledger().noteRejected(
        {
          accountDigest: binding.accountDigest,
          model: binding.model,
          untilMs,
          observedAtMs: now,
        },
        now,
      )
    )
      this.#refreshPool(binding);
    return true;
  }

  noteAvailable(
    agentId: string,
    launch: ClaudeModelQuotaLaunch,
    event: RuntimeModelWindowAvailable,
  ): boolean {
    const binding = this.#matchingBinding(agentId, launch, event.modelWindow);
    if (!binding) return false;
    if (
      !this.ledger().noteAvailable({
        accountDigest: binding.accountDigest,
        model: binding.model,
        untilMs: Date.parse(event.resetsAt),
        observedAtMs: Date.parse(event.occurredAt),
      })
    )
      return false;
    this.#refreshPool(binding);
    return true;
  }

  unbind(agentId: string, launch?: ClaudeModelQuotaLaunch): boolean {
    const binding = this.#bindings.get(agentId);
    if (!binding || (launch && binding.launch !== launch)) return false;
    clearTimeout(binding.timer);
    delete binding.launch.modelQuotaInputHeld;
    this.#bindings.delete(agentId);
    return binding.untilMs !== undefined;
  }

  dispose(): string[] {
    return [...this.#bindings.keys()].filter((agentId) => this.unbind(agentId));
  }

  #matchingBinding(
    agentId: string,
    launch: ClaudeModelQuotaLaunch,
    window: RuntimeModelWindow,
  ): Binding | undefined {
    const binding = this.#bindings.get(agentId);
    if (binding?.launch === launch && window.window === "weekly" && binding.model === window.model)
      return binding;
  }

  #refreshPool(pool: Binding): void {
    for (const [agentId, binding] of this.#bindings) {
      if (binding.accountDigest === pool.accountDigest && binding.model === pool.model)
        this.#refresh(agentId, binding);
    }
  }

  #refresh(agentId: string, binding: Binding): void {
    const now = Date.now();
    const untilMs = this.ledger().active(binding.accountDigest, binding.model, now)?.untilMs;
    const previous = binding.untilMs;
    if (untilMs === previous && (untilMs === undefined || binding.timer !== undefined)) return;
    clearTimeout(binding.timer);
    binding.untilMs = untilMs;
    binding.timer =
      untilMs === undefined
        ? undefined
        : setTimeout(() => {
            binding.timer = undefined;
            this.#refreshPool(binding);
          }, untilMs - now);
    if (untilMs !== undefined) binding.launch.modelQuotaInputHeld = true;
    if ((previous === undefined) !== (untilMs === undefined))
      this.project(agentId, untilMs !== undefined);
  }
}
